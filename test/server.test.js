// Black-box tests: start the real server process against a fake FanDuel, feed DraftKings through the relay,
// and watch what a browser would receive over SSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { fixture, waitFor } from './helpers.js';

const SNAP = fixture('fd-snapshot.json');
const DK_SNAP = fixture('dk-snapshot.json');
const PRICES = fixture('fd-prices.json');
const TOKEN = 'test-token';
const GAME = 'BAL@BUF:2026-11-01';

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

async function fakeFanDuel() {
  const st = { mode: 'ok', prices: structuredClone(PRICES) };
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/snapshot')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(SNAP)); }
    req.resume(); req.on('end', () => {
      if (st.mode !== 'ok') { res.writeHead(500); return res.end('down'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(st.prices));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { st, base, close: () => srv.close() };
}

/** Minimal SSE client: collects parsed events. */
function sse(url) {
  const events = []; const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, { signal: ctrl.signal }); const dec = new TextDecoder(); let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (\w+)/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) events.push({ ev, data: JSON.parse(data), at: Date.now() });
        }
      }
    } catch {}
  })();
  return { events, close: () => ctrl.abort() };
}

let fake, proc, base, port;
test.before(async () => {
  fake = await fakeFanDuel(); port = await freePort(); base = `http://127.0.0.1:${port}`;
  const dead = await freePort();
  proc = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), SOURCES: 'draftkings,fanduel', INGEST_TOKEN: TOKEN,
    DK_NASH_BASE: `http://127.0.0.1:${dead}`, DK_WS_URL: `ws://127.0.0.1:${dead}/websocket`,
    FD_SNAPSHOT_URL: `${fake.base}/snapshot`, FD_PRICES_URL: `${fake.base}/prices`, FD_POLL_MS: '100', FD_STALE_MS: '1200', DK_STALE_MS: '1200', EXTRAS: '0', FD_PUSH: '0', DK_HTTP: 'native' }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.resume(); proc.stderr.resume();
  await waitFor(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } }, 5000);
});
test.after(() => { proc?.kill(); fake?.close(); });

test('serves the board and a liveness check', async () => {
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h.ok, true);
  await waitFor(async () => (await (await fetch(`${base}/api/board`)).json()).quotes.length === 18);
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /<script type="module" src="\/app.js"><\/script>/);
  // the page is an ES-module app: the core, the shared price rules and every theme must be served with JS/CSS types
  for (const [path, type] of [['/app.js', /javascript/], ['/lib/model.js', /javascript/], ['/themes/pressbox.js', /javascript/], ['/themes/pressbox.css', /css/], ['/themes/grid.js', /javascript/], ['/themes/grid.css', /css/]]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type'), type, path);
  }
  // the browser uses the same compare() the tests check, so the page can never rank prices differently
  assert.match(await (await fetch(`${base}/lib/model.js`)).text(), /export function compare/);
});

test('the page gets a data-age beat as each poll lands, so "data X s ago" is never a heartbeat late', async () => {
  const s = sse(`${base}/api/stream`);
  try {
    await waitFor(() => s.events.filter((e) => e.ev === 'beat').length >= 3, 3000);
    const beats = s.events.filter((e) => e.ev === 'beat');
    for (const b of beats) { const age = b.at - b.data.fanduel[0]; assert.ok(age >= -50 && age < 400, `FanDuel data was ${age} ms old when the beat arrived (100 ms poll)`); }
    const gaps = beats.slice(1).map((b, i) => b.at - beats[i].at);
    assert.ok(gaps.every((g) => g >= 200), `beats are throttled to 4 per second: ${gaps}`);
  } finally { s.close(); }
});

test('a FanDuel price change reaches an SSE viewer within one poll', async () => {
  const s = sse(`${base}/api/stream`);
  try {
    await waitFor(() => s.events.some((e) => e.ev === 'snapshot'));
    const changedAt = Date.now();
    fake.st.prices[0].runnerDetails[0].winRunnerOdds.americanDisplayOdds.americanOdds = 333;
    const hit = await waitFor(() => s.events.find((e) => e.ev === 'batch' && e.data.quotes.some((q) => q.book === 'fanduel' && q.odds === 333)), 2000);
    assert.ok(hit.at - changedAt < 400, `took ${hit.at - changedAt} ms with a 100 ms poll`);
    const q = hit.data.quotes.find((x) => x.odds === 333);
    assert.equal(q.prevOdds, 150); assert.ok(q.updatedAt > 0);
  } finally { s.close(); }
});

test('the relay rejects a wrong token, both over WebSocket and HTTP', async () => {
  const r = await fetch(`${base}/ingest/dk-snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(r.status, 401);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest/ws`, { headers: { authorization: 'Bearer nope' } });
  const code = await new Promise((res) => { ws.on('unexpected-response', (_, resp) => res(resp.statusCode)); ws.on('error', () => res('error')); ws.on('open', () => res('open')); });
  assert.notEqual(code, 'open');
});

test('a DraftKings snapshot relayed from an edge fills the board, and viewers get it at once', async () => {
  const s = sse(`${base}/api/stream`);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest/ws`, { headers: { authorization: `Bearer ${TOKEN}` } });
  try {
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    const pong = new Promise((r) => ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'pong') r(m); }));
    ws.send(JSON.stringify({ type: 'ping', t: 42 }));
    assert.equal((await pong).t, 42);
    await waitFor(() => s.events.some((e) => e.ev === 'snapshot'));
    const sentAt = Date.now();
    ws.send(JSON.stringify({ type: 'snapshot', why: 'test', edgeTs: Date.now(), rttMs: 30, snapshot: DK_SNAP }));
    const hit = await waitFor(() => s.events.find((e) => e.ev === 'batch' && e.data.quotes.some((q) => q.book === 'draftkings')), 3000);
    assert.ok(hit.at - sentAt < 300, `relay → viewer took ${hit.at - sentAt} ms`);
    assert.equal(hit.data.quotes.filter((q) => q.book === 'draftkings').length, 18);
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.books.draftkings.quotes, 18); assert.equal(h.books.draftkings.snapshotVia, 'edge');
    assert.ok(h.books.draftkings.snapshotAgeMs < 2000);
    const m = await (await fetch(`${base}/api/metrics`)).json();
    assert.equal(m.draftkings.relayRtt.count, 1);
  } finally { ws.close(); s.close(); }
});

test('FanDuel interleave: half a beat after its own poll the server asks the edge, and the edge\'s answer reaches viewers', async () => {
  const s = sse(`${base}/api/stream`);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ingest/ws`, { headers: { authorization: `Bearer ${TOKEN}` } });
  try {
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    const asks = [];
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'fd-poll') asks.push({ ...m, at: Date.now() }); });
    await waitFor(() => asks.length >= 3, 2000);
    assert.equal(asks[0].marketIds.length, 9); assert.equal(asks[0].region, 'ON');
    const gaps = asks.slice(1).map((a, i) => a.at - asks[i].at);
    assert.ok(gaps.every((g) => g > 60 && g < 160), `one ask per 100 ms beat: ${gaps}`);
    await waitFor(() => s.events.some((e) => e.ev === 'snapshot'));
    const changed = structuredClone(PRICES.filter((m) => m.marketId === '734.192676407')); changed[0].runnerDetails[1].winRunnerOdds.americanDisplayOdds.americanOdds = -171;
    const ask = asks[asks.length - 1];
    ws.send(JSON.stringify({ type: 'fd-prices', t: Date.now(), rttMs: 0, markets: changed }));
    const hit = await waitFor(() => s.events.find((e) => e.ev === 'batch' && e.data.quotes.some((q) => q.book === 'fanduel' && q.odds === -171)), 2000);
    assert.ok(hit);
    const m = await (await fetch(`${base}/api/metrics`)).json();
    assert.ok(m.fanduel.edgePolls >= 1);
  } finally { ws.close(); s.close(); }
});

test('one book failing never stops the other, and stale is reported per book', async () => {
  const health = async () => { const r = await fetch(`${base}/api/health`); return { status: r.status, ...(await r.json()) }; };
  // DraftKings (whose socket cannot connect in this test) is stale; FanDuel keeps polling fine
  const h1 = await waitFor(async () => { const h = await health(); return h.books.draftkings.stale && !h.books.fanduel.stale ? h : null; }, 6000);
  assert.equal(h1.status, 503);
  assert.ok(h1.books.fanduel.dataAgeMs < 1000);
  // now FanDuel breaks: it goes stale too, but its last prices are kept (greyed in the UI), not deleted
  fake.st.mode = 'down';
  const h2 = await waitFor(async () => { const h = await health(); return h.books.fanduel.stale ? h : null; }, 4000);
  assert.equal(h2.books.fanduel.state, 'down');
  assert.equal(h2.books.fanduel.quotes, 18);
  // and recovers by itself
  fake.st.mode = 'ok';
  await waitFor(async () => !(await health()).books.fanduel.stale, 6000);
});
