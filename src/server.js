// HTTP server: serves the board UI, a JSON snapshot, a Server-Sent Events stream of changes,
// the DraftKings relay endpoint (edge → cloud) and health/metrics.
//
// Why SSE and not WebSocket for browsers: the browser only needs to LISTEN. SSE is one-way, plain HTTP,
// reconnects by itself (EventSource), and passes every proxy/CDN. One ingestion per book feeds one store;
// N browsers just subscribe to the store — adding viewers never adds requests to the books.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { BoardStore } from './store.js';
import { Metrics } from './metrics.js';
import { DraftKingsSource } from './sources/draftkings.js';
import { FanDuelSource } from './sources/fanduel.js';
import { BOOKS } from './model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// 0 = no waiting: flush once the current upstream message has been fully applied (setImmediate). Everything one
// DK frame or one FD poll changed still leaves in ONE event, because those changes are applied synchronously.
const BATCH_MS = Number(process.env.SSE_BATCH_MS || 0);
// Stale = no proof of life for this long. DK proves life with data or a ping/pong every 30 s; FD with every poll (1 s).
const STALE_MS = { draftkings: Number(process.env.DK_STALE_MS || 75_000), fanduel: Number(process.env.FD_STALE_MS || 10_000) };
const SOURCES = (process.env.SOURCES ?? 'draftkings,fanduel').split(',').map((s) => s.trim()).filter(Boolean);
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const VERSION = (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'dev').slice(0, 7);

const log = (tag, ...a) => console.log(new Date().toISOString(), `[${tag}]`, ...a);
const store = new BoardStore();
const metrics = new Metrics();
const sources = [];
if (SOURCES.includes('draftkings')) sources.push(new DraftKingsSource(store, metrics, log));
if (SOURCES.includes('fanduel')) sources.push(new FanDuelSource(store, metrics, log));

// ---------- SSE fan-out ----------
const clients = new Set();
let pending = { quotes: new Map(), games: new Map(), sources: new Map(), firstAt: null, scheduled: false };
function queue(kind, item, key) {
  pending[kind].set(key, item);
  if (!pending.firstAt) pending.firstAt = Date.now();
  if (!pending.scheduled) { pending.scheduled = true; BATCH_MS > 0 ? setTimeout(flush, BATCH_MS) : setImmediate(flush); }
}
function flush() {
  const batch = { serverTs: Date.now(), quotes: [...pending.quotes.values()], games: [...pending.games.values()], sources: Object.fromEntries(pending.sources) };
  metrics.sse.coalesceWait.push(Date.now() - pending.firstAt);
  pending = { quotes: new Map(), games: new Map(), sources: new Map(), firstAt: null, scheduled: false };
  const payload = `event: batch\ndata: ${JSON.stringify(batch)}\n\n`;
  metrics.sse.batchesSent++; metrics.sse.batchSize.push(batch.quotes.length);
  for (const res of clients) { res.write(payload); metrics.sse.bytesSent += payload.length; }
}
store.on('quote', (q) => queue('quotes', q, q.id));
store.on('game', (g) => queue('games', g, g.key));
store.on('source', (s) => queue('sources', s, s.book));
setInterval(() => store.refreshStaleness(STALE_MS), 1000);
setInterval(() => { // status heartbeat: "data 3 s ago" counters, and keeps proxies from closing idle streams
  const payload = `event: batch\ndata: ${JSON.stringify({ serverTs: Date.now(), quotes: [], games: [], sources: store.sources })}\n\n`;
  for (const res of clients) res.write(payload);
}, 5_000);

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));

const snapshot = () => ({ ...store.snapshot(), config: { staleMs: STALE_MS, batchMs: BATCH_MS } });
app.get('/api/board', (req, res) => res.json(snapshot()));
app.get('/api/time', (req, res) => res.json({ serverTs: Date.now() }));
app.get('/api/metrics', (req, res) => res.json({ version: VERSION, ...metrics.toJSON(), sources: store.sources, staleThresholdsMs: STALE_MS, sseBatchMs: BATCH_MS }));
// Liveness for the host (never fails because a BOOK is down — restarting us would not fix DraftKings).
app.get('/healthz', (req, res) => res.json({ ok: true, version: VERSION, games: store.games.size, quotes: store.quotes.size, clients: clients.size }));
// Readiness for monitoring: 503 unless both books are fresh and the board has games.
app.get('/api/health', (req, res) => {
  const now = Date.now();
  const books = Object.fromEntries(BOOKS.map((b) => {
    const s = store.sources[b];
    return [b, { state: s.state, mode: s.mode, stale: s.stale, dataAgeMs: s.lastDataAt ? now - s.lastDataAt : null, quotes: [...store.quotes.values()].filter((q) => q.book === b).length, lastError: s.lastError }];
  }));
  const ok = store.games.size > 0 && BOOKS.every((b) => !books[b].stale && books[b].quotes > 0);
  res.status(ok ? 200 : 503).json({ ok, version: VERSION, games: store.games.size, books, clients: clients.size });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.socket?.setNoDelay(true); // small frames go out immediately (no Nagle delay)
  res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res); metrics.sse.clients = clients.size;
  req.on('close', () => { clients.delete(res); metrics.sse.clients = clients.size; });
});

// Browsers report what they measured so the numbers in /api/metrics are true end-to-end, not server-only.
app.post('/api/report', (req, res) => {
  const { pushLag = {}, endToEnd = {} } = req.body || {};
  for (const b of BOOKS) for (const v of [].concat(pushLag[b] || []).slice(0, 5000)) metrics.browser.pushLag[b].push(Number(v));
  for (const phase of ['pregame', 'live']) for (const v of [].concat(endToEnd.draftkings?.[phase] || []).slice(0, 5000)) metrics.browser.endToEnd.draftkings[phase].push(Number(v));
  metrics.browser.reports++;
  res.json({ ok: true });
});

// ---------- DraftKings relay (DK collected on an edge machine, see src/edge.js) ----------
let lastEdgeAt = 0;
function ingestDraftKings(body, now = Date.now()) {
  const { quotes = [], games = [], source, edgeTs, rttMs } = body || {};
  lastEdgeAt = now; metrics.dk.relayMessages++;
  if (Number.isFinite(rttMs)) metrics.dk.relayRtt.push(rttMs);
  for (const g of games) if (g?.key) store.upsertGame(g);
  let changed = 0;
  for (const q of quotes) {
    if (q?.book !== 'draftkings' || !q.gameKey) continue;
    if (q.removed) { store.removeQuotes('draftkings', q.gameKey, q.market); continue; }
    const did = store.upsertQuote({ gameKey: q.gameKey, market: q.market, side: q.side, book: q.book, line: q.line ?? null, odds: q.odds ?? null, suspended: q.suspended, sourceTs: q.sourceTs ?? null }, now);
    // book→cloud lag only for real changes that just happened (the edge also re-sends the whole board periodically)
    if (did) { changed++; if (q.sourceTs && now - q.sourceTs < 60_000) { const g = store.games.get(q.gameKey); (g?.status === 'live' ? metrics.dk.ingestLagLive : metrics.dk.ingestLagPregame).push(now - q.sourceTs); } }
  }
  if (source) {
    // Times measured on the edge are converted with a difference taken on the edge's own clock, so clock skew cancels.
    const shift = (ts) => (ts && edgeTs ? now - Math.max(0, edgeTs - ts) : ts ?? null);
    const { stale, lastDataAt, lastChangeAt, lastSnapshotAt, ...rest } = source; // staleness is judged here, not at the edge
    store.setSource('draftkings', { ...rest, mode: 'websocket (via edge)', lastDataAt: shift(lastDataAt) ?? now, lastChangeAt: shift(lastChangeAt), lastSnapshotAt: shift(lastSnapshotAt), relayRttMs: Number.isFinite(rttMs) ? rttMs : undefined });
  }
  return changed;
}
const authorized = (h) => !!INGEST_TOKEN && h === `Bearer ${INGEST_TOKEN}`;
app.post('/ingest/draftkings', (req, res) => {
  if (!authorized(req.headers.authorization)) return res.status(401).json({ error: 'bad token' });
  res.json({ ok: true, changed: ingestDraftKings(req.body) });
});

// Diagnostics: what does DraftKings say to THIS server's IP? (documents geo / bot blocking honestly)
app.get('/api/diag/draftkings', async (req, res) => {
  const out = { serverTs: Date.now(), lastEdgeAt: lastEdgeAt || null, sites: {} };
  try { out.ip = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) })).json(); } catch (e) { out.ip = String(e); }
  for (const site of ['US-OH-SB', 'US-NJ-SB', 'CA-ON-SB']) {
    try {
      const r = await fetch(`https://sportsbook-nash.draftkings.com/sites/${site}/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=88808&entity=events&include=Events&eventsQuery=%24filter%3DleagueId%20eq%20%2788808%27&marketsQuery=%24filter%3DclientMetadata%2FsubCategoryId%20eq%20%274518%27`, { headers: { accept: 'application/json', referer: 'https://sportsbook.draftkings.com/', 'x-client-name': 'web' }, signal: AbortSignal.timeout(8000) });
      const t = await r.text(); const plain = t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))); out.sites[site] = { status: r.status, akamaiRef: /Reference #([\w.]+)/.exec(plain)?.[1] || null, bytes: t.length };
    } catch (e) { out.sites[site] = { error: String(e) }; }
  }
  try { const r = await fetch('https://sportsbook.draftkings.com/leagues/football/nfl', { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }); out.page = { status: r.status, bytes: (await r.text()).length }; } catch (e) { out.page = String(e); }
  res.json(out);
});

const server = app.listen(PORT, () => log('http', `listening on :${PORT} · sources=${SOURCES.join('+') || 'none'} · batch=${BATCH_MS || 'immediate'} · stale dk=${STALE_MS.draftkings} fd=${STALE_MS.fanduel} · v${VERSION}`));

// Relay over ONE long-lived WebSocket (no per-batch HTTP request). Edge sends {type:'batch',…} and {type:'ping',t}.
const relay = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ingest/ws') return socket.destroy();
  if (!authorized(req.headers.authorization)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  relay.handleUpgrade(req, socket, head, (ws) => relay.emit('connection', ws, req));
});
relay.on('connection', (ws, req) => {
  ws._socket?.setNoDelay(true);
  log('relay', `edge connected from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    if (msg.type === 'batch') ingestDraftKings(msg);
  });
  ws.on('close', () => log('relay', 'edge disconnected'));
});

for (const s of sources) s.start().catch((e) => log('src', 'start failed', e));
const shutdown = () => { for (const s of sources) s.stop(); server.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
