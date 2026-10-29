// HTTP for the book workers: Node's fetch first, a browser-compatible client when a host refuses Node.
//
// Why: DraftKings' REST snapshot host answers 403 to Node's fetch from cloud IPs (Akamai looks at the TLS/HTTP2
// handshake, and Node's does not look like a browser's). The same request made with Chrome's handshake
// (curl_cffi, src/transport/curl_worker.py) is accepted from the same cloud IP. So in 'auto' mode we try Node first
// and, on the first 403, switch that client to the browser-compatible worker for good. Locally (residential IP)
// Node is accepted and the worker never starts.
//
// The worker is ONE long-lived Python process with warm keep-alive sessions: ~60-100 ms per snapshot after the
// first, instead of a process start + TLS handshake per request. If it crashes it is restarted on the next request.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORKER = fileURLToPath(new URL('./curl_worker.py', import.meta.url));

/** Python with curl_cffi installed: $PYTHON, else the project's .venv (made by tools/install-transport.mjs). */
export const defaultPython = () => process.env.PYTHON || (existsSync(`${ROOT}.venv/bin/python`) ? `${ROOT}.venv/bin/python` : null);

export class HttpError extends Error {
  constructor(status, msg, retryAfterMs = null) { super(msg || `HTTP ${status}`); this.status = status; this.retryAfterMs = retryAfterMs; }
}

export class CurlWorker {
  constructor({ command = defaultPython(), args = ['-u', WORKER], log = () => {}, startTimeoutMs = 15_000 } = {}) {
    this.command = command; this.args = args; this.log = log; this.startTimeoutMs = startTimeoutMs;
    this.proc = null; this.ready = null; this.pending = new Map(); this.nextId = 1; this.failures = 0;
    this.stats = { requests: 0, errors: 0, restarts: 0, lastMs: null };
  }

  get available() { return !!this.command && this.failures < 5; }

  start() {
    if (this.ready) return this.ready;
    const proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    this.proc = proc;
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error('browser-compatible client did not start')); proc.kill(); }, this.startTimeoutMs);
      proc.once('error', (e) => { clearTimeout(t); reject(e); if (this.proc === proc) { this.proc = null; this.ready = null; this.failures++; } });
      createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        if (msg.id === null && msg.ready) { clearTimeout(t); this.failures = 0; return resolve(); }
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        this.stats.lastMs = msg.ms ?? null;
        if (msg.error) { this.stats.errors++; p.reject(new Error(msg.error)); } else p.resolve(msg);
      });
    });
    this.ready.catch(() => {}); // a failed start is reported to the request that awaited it
    proc.stdin.on('error', () => {}); // writing to a worker that just died must not crash the server
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-400); });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null; this.ready = null; this.failures++;
      if (code !== 0) this.log('http', `browser-compatible client exited (${code}) ${errTail.trim().split('\n').pop() || ''}`);
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('browser-compatible client exited')); }
      this.pending.clear();
    });
    return this.ready;
  }

  async request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15_000 } = {}) {
    if (!this.available) throw new Error('browser-compatible client unavailable');
    if (!this.proc) { if (this.stats.requests) this.stats.restarts++; }
    await this.start();
    const id = this.nextId++; this.stats.requests++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout after ${timeoutMs} ms`)); }, timeoutMs + 1000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, url, method, headers, body, timeout: timeoutMs / 1000 }) + '\n');
    });
  }

  stop() { const p = this.proc; this.proc = null; this.ready = null; p?.kill(); }
}

/**
 * mode: 'native' (Node fetch only), 'browser' (worker only), 'auto' (Node, then the worker after the first 403).
 * getJson resolves with parsed JSON on 200 and throws HttpError(status) otherwise.
 */
export function makeHttp({ mode = process.env.DK_HTTP || 'auto', worker = null, log = () => {}, fetchImpl = (...a) => fetch(...a) } = {}) {
  let w = worker;
  const getWorker = () => (w ||= new CurlWorker({ log }));
  let current = mode === 'browser' ? 'browser' : 'native';
  const stats = { native: 0, browser: 0, switchedAt: null };

  async function viaWorker(url, headers, timeoutMs) {
    const r = await getWorker().request(url, { headers, timeoutMs });
    stats.browser++;
    if (r.status !== 200) throw new HttpError(r.status, `HTTP ${r.status} ${String(r.body || '').slice(0, 120)}`, r.retryAfter ? Number(r.retryAfter) * 1000 : null);
    return JSON.parse(r.body);
  }

  return {
    get transport() { return current === 'browser' ? 'browser-compatible' : 'native'; },
    get stats() { return { ...stats, transport: this.transport, worker: w?.stats ?? null }; },
    async getJson(url, headers = {}, timeoutMs = 15_000) {
      if (current === 'browser' && !getWorker().available) { current = 'native'; log('http', 'browser-compatible client keeps failing → back to Node\'s client'); }
      if (current === 'browser') return viaWorker(url, headers, timeoutMs);
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      stats.native++;
      if (r.status === 200) return r.json();
      const text = await r.text().catch(() => '');
      if (r.status === 403 && mode === 'auto' && getWorker().available) {
        current = 'browser'; stats.switchedAt = Date.now();
        log('http', `${new URL(url).host} refuses Node's client (403) → switching to the browser-compatible client`);
        return viaWorker(url, headers, timeoutMs);
      }
      throw new HttpError(r.status, `HTTP ${r.status} ${text.slice(0, 120)}`);
    },
    stop() { w?.stop(); },
  };
}
