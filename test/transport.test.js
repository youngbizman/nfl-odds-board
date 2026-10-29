// The DraftKings snapshot client: Node first, the browser-compatible worker after the first 403.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makeHttp, CurlWorker, HttpError, defaultPython } from '../src/transport/http.js';

const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('auto: a 403 to Node switches to the browser-compatible client for good; a 200 never does', async () => {
  const calls = { node: 0, worker: 0 };
  const worker = { available: true, stats: {}, request: async () => { calls.worker++; return { status: 200, body: '{"events":[1]}' }; } };
  const blocked = makeHttp({ mode: 'auto', worker, fetchImpl: async () => { calls.node++; return json(403, 'Access Denied'); } });
  assert.deepEqual(await blocked.getJson('https://x.test/a'), { events: [1] });
  assert.equal(blocked.transport, 'browser-compatible');
  await blocked.getJson('https://x.test/b');
  assert.deepEqual(calls, { node: 1, worker: 2 }, 'after the switch Node is not asked again');

  const open = makeHttp({ mode: 'auto', worker: { ...worker, request: async () => assert.fail('worker must not be used') }, fetchImpl: async () => json(200, { ok: 1 }) });
  assert.deepEqual(await open.getJson('https://x.test/'), { ok: 1 });
  assert.equal(open.transport, 'native');
});

test('native mode reports the HTTP status; without a usable worker auto mode does too', async () => {
  const native = makeHttp({ mode: 'native', fetchImpl: async () => json(403, 'no') });
  await assert.rejects(native.getJson('https://x.test/'), (e) => e instanceof HttpError && e.status === 403);
  const noWorker = makeHttp({ mode: 'auto', worker: { available: false }, fetchImpl: async () => json(403, 'no') });
  await assert.rejects(noWorker.getJson('https://x.test/'), (e) => e.status === 403);
  assert.equal(noWorker.transport, 'native');
  const workerSays = makeHttp({ mode: 'browser', worker: { available: true, request: async () => ({ status: 429, body: 'slow', retryAfter: '2' }) } });
  await assert.rejects(workerSays.getJson('https://x.test/'), (e) => e.status === 429 && e.retryAfterMs === 2000);
});

test('a missing interpreter fails the request cleanly and never crashes the server', async () => {
  const w = new CurlWorker({ command: '/nonexistent/python3' });
  await assert.rejects(w.request('http://127.0.0.1:1/'));
  assert.equal(w.proc, null);
});

// The real worker, when this machine has it (npm run postinstall with INSTALL_CURL_TRANSPORT=1).
const py = defaultPython();
const hasCurl = !!py && existsSync(py) && (() => { try { execFileSync(py, ['-c', 'import curl_cffi']); return true; } catch { return false; } })();
test('real browser-compatible worker: Chrome handshake, warm keep-alive, parallel requests, survives a crash', { skip: !hasCurl && 'curl_cffi not installed here' }, async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.headers['user-agent'] || '');
    if (!/Chrome\/\d+/.test(req.headers['user-agent'] || '')) { res.writeHead(403); return res.end('Access Denied'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, client: req.headers['x-client-name'] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const h = makeHttp({ mode: 'auto' });
  try {
    assert.deepEqual(await h.getJson(`${base}/snap`, { 'x-client-name': 'web' }), { path: '/snap', client: 'web' });
    assert.equal(h.transport, 'browser-compatible');
    assert.match(seen.at(-1), /Chrome\//, 'the impersonated browser supplies its own User-Agent');
    const t0 = Date.now(); await h.getJson(`${base}/warm`); const warm = Date.now() - t0;
    assert.ok(warm < 500, `warm request took ${warm} ms`);
    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => h.getJson(`${base}/p${i}`)));
    assert.deepEqual(many.map((m) => m.path), Array.from({ length: 8 }, (_, i) => `/p${i}`));
    // the worker dies (OOM, bug): the next request starts a new one
    const w = new CurlWorker();
    assert.equal((await w.request(`${base}/one`)).status, 200);
    w.proc.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 200));
    assert.equal((await w.request(`${base}/two`)).status, 200);
    assert.equal(w.stats.restarts, 1);
    w.stop();
  } finally { h.stop(); srv.close(); }
});
