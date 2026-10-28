// Edge worker: runs the DraftKings collector from a network DK accepts (a residential IP in a licensed region)
// and relays normalized changes to the cloud server, which serves the viewers.
//
// Why this exists: DraftKings' Akamai layer returns 403 to cloud/datacenter IPs for every regional site
// (see README → "What we hit"). FanDuel is fine from the cloud, so only the DK collector moves to the edge.
//
//   DK ──WS──▶ [edge: DraftKingsSource → BoardStore] ══ one open WebSocket /ingest/ws ══▶ [cloud BoardStore] ──SSE──▶ browsers
//
// Each DK frame's changes leave the edge immediately (setImmediate, no timer) over a socket that is already open,
// so the relay adds roughly one network hop (Toronto → Ohio, ~15–25 ms one way). If the socket is down,
// batches fall back to HTTPS POST /ingest/draftkings so nothing waits for the reconnect.
//
// Usage:  CLOUD_URL=https://… INGEST_TOKEN=… node src/edge.js
import WebSocket from 'ws';
import { BoardStore } from './store.js';
import { Metrics } from './metrics.js';
import { DraftKingsSource } from './sources/draftkings.js';

const CLOUD = (process.env.CLOUD_URL || '').replace(/\/$/, '');
const TOKEN = process.env.INGEST_TOKEN || '';
if (!CLOUD || !TOKEN) { console.error('CLOUD_URL and INGEST_TOKEN are required'); process.exit(1); }

const log = (tag, ...a) => console.log(new Date().toISOString(), `[edge:${tag}]`, ...a);
const store = new BoardStore();
const metrics = new Metrics();
const dk = new DraftKingsSource(store, metrics, log);

// ---------- relay socket ----------
let ws = null, backoff = 500, rttMs = null, sentWs = 0, sentHttp = 0, failed = 0, lastOkAt = 0;
function connect() {
  const sock = new WebSocket(`${CLOUD.replace(/^http/, 'ws')}/ingest/ws`, { headers: { authorization: `Bearer ${TOKEN}` }, perMessageDeflate: false, handshakeTimeout: 10_000 });
  ws = sock;
  sock.on('open', () => { backoff = 500; sock._socket?.setNoDelay(true); log('relay', 'connected'); sendFullBoard(); ping(); });
  sock.on('message', (d) => { try { const m = JSON.parse(d); if (m.type === 'pong') rttMs = Date.now() - m.t; } catch {} });
  sock.on('error', (e) => log('relay', `error: ${e.message}`));
  sock.on('close', () => { if (ws === sock) { ws = null; log('relay', `closed; reconnecting in ${backoff} ms`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15_000); } });
}
function ping() { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }
setInterval(ping, 10_000);

async function send(body) {
  body.edgeTs = Date.now(); body.rttMs = rttMs;
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'batch', ...body })); sentWs++; lastOkAt = Date.now(); return; }
  try { // socket down: don't make the price wait for the reconnect
    const r = await fetch(`${CLOUD}/ingest/draftkings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    sentHttp++; lastOkAt = Date.now();
  } catch (e) { failed++; log('relay', `fallback POST failed: ${e.message} (${body.quotes.length} quotes)`); }
}

// ---------- batching: one message per upstream DK frame ----------
let pending = { quotes: new Map(), games: new Map(), source: null, scheduled: false };
function queue(kind, item, key) {
  if (kind === 'source') pending.source = item; else pending[kind].set(key, item);
  if (!pending.scheduled) { pending.scheduled = true; setImmediate(flush); }
}
function flush() {
  const body = { quotes: [...pending.quotes.values()], games: [...pending.games.values()], source: pending.source || { ...store.sources.draftkings } };
  pending = { quotes: new Map(), games: new Map(), source: null, scheduled: false };
  send(body);
}
store.on('quote', (q) => queue('quotes', q, q.id));
store.on('game', (g) => queue('games', g, g.key));
store.on('source', (s) => queue('source', s));
function sendFullBoard() {
  for (const g of store.games.values()) queue('games', g, g.key);
  for (const q of store.quotes.values()) if (q.book === 'draftkings') queue('quotes', q, q.id);
  queue('source', { ...store.sources.draftkings });
}
// Proof of life every 5 s (status only, tiny); the whole DK board every 30 s so the cloud converges after any loss or restart.
setInterval(() => queue('source', { ...store.sources.draftkings }), 5_000);
setInterval(sendFullBoard, 30_000);
setInterval(() => log('stat', `relay ws=${sentWs} http=${sentHttp} failed=${failed} rtt=${rttMs ?? '—'} ms lastOk=${lastOkAt ? Math.round((Date.now() - lastOkAt) / 1000) + 's ago' : 'never'} · dk ${store.sources.draftkings.state} · quotes ${store.quotes.size} · lineMovesMapped ${metrics.dk.lineMovesMapped}`), 60_000);

connect();
dk.start().catch((e) => log('dk', 'start failed', e));
const shutdown = () => { dk.stop(); ws?.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
