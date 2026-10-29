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
import { makeCheckpoint } from './checkpoint.js';

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
const edges = new Set(); // relay sockets from edge machines (snapshot providers)
const askEdgeForSnapshot = (why) => { for (const ws of edges) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'need-snapshot', why })); };
const firstEdge = () => [...edges].find((ws) => ws.readyState === 1);
// FanDuel interleave: half a beat after our own poll, ask the edge (another IP) to poll the same markets
const askEdgeToPollFanDuel = (marketIds) => { const ws = firstEdge(); if (!ws || process.env.FD_INTERLEAVE === '0') return false; ws.send(JSON.stringify({ type: 'fd-poll', t: Date.now(), region: fd.region, marketIds })); return true; };
const checkpoint = SOURCES.includes('draftkings') ? await makeCheckpoint(log) : null;
const dk = SOURCES.includes('draftkings') ? new DraftKingsSource(store, metrics, log, { onNeedSnapshot: askEdgeForSnapshot, checkpoint }) : null;
const fd = SOURCES.includes('fanduel') ? new FanDuelSource(store, metrics, log, { onMidBeat: askEdgeToPollFanDuel }) : null;
if (dk) sources.push(dk);
if (fd) sources.push(fd);
// Price history for the movement charts survives restarts in the same Redis (one JSON value, saved every minute).
const HISTORY_KEY = 'board:history';
if (checkpoint) try { const h = await checkpoint.loadBlob(HISTORY_KEY); if (h) { store.importHistory(JSON.parse(h)); log('history', `restored ${store.history.size} series`); } } catch (e) { log('history', `restore failed: ${e.message}`); }
const saveHistory = () => checkpoint?.saveBlob(HISTORY_KEY, JSON.stringify(store.exportHistory())).catch((e) => log('history', `save failed: ${e.message}`));
setInterval(saveHistory, 60_000);

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
setInterval(() => { // live latency figures for the feed cards (ride the heartbeat below)
  const dkLag = metrics.dk.ingestLagLive.stats().count ? metrics.dk.ingestLagLive.stats() : metrics.dk.ingestLagPregame.stats();
  store.sources.draftkings.lagP50Ms = dkLag.p50 ?? null; store.sources.draftkings.lagCount = dkLag.count;
  store.sources.fanduel.freshP50Ms = metrics.fd.freshInterval.stats().p50 ?? null;
}, 5_000);
setInterval(() => { // status heartbeat: "data 3 s ago" counters, and keeps proxies from closing idle streams
  const payload = `event: batch\ndata: ${JSON.stringify({ serverTs: Date.now(), quotes: [], games: [], sources: store.sources })}\n\n`;
  for (const res of clients) res.write(payload);
}, 5_000);
// Age beat: the moment a book's data timestamp moves (at most every 250 ms) push just the two timestamps per book,
// so "data 0.4 s ago" on the page is exact rather than up to a heartbeat late.
let lastBeat = { at: 0, sig: '' };
setInterval(() => {
  if (!clients.size) return;
  const t = {}; for (const [b, s] of Object.entries(store.sources)) t[b] = [s.lastDataAt, s.lastChangeAt];
  const sig = JSON.stringify(t), now = Date.now();
  if (sig === lastBeat.sig || now - lastBeat.at < 250) return;
  lastBeat = { at: now, sig };
  const payload = `event: beat\ndata: ${sig}\n\n`;
  for (const res of clients) res.write(payload);
}, 100);

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));
// the browser uses the exact same comparison rules the tests check
app.get('/lib/model.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'model.js')));

const snapshot = () => ({ ...store.snapshot(), config: { staleMs: STALE_MS, batchMs: BATCH_MS } });
// The snapshot is ~100 KB; serialising it per viewer would make a burst of joins CPU-bound. Serialise once per change.
let boardVersion = 0, snapCache = { version: -1, sse: '' };
for (const ev of ['quote', 'game', 'source']) store.on(ev, () => boardVersion++);
function snapshotSse() {
  if (snapCache.version !== boardVersion) snapCache = { version: boardVersion, sse: `retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n` };
  return snapCache.sse;
}
app.get('/api/board', (req, res) => res.json(snapshot()));
app.get('/api/time', (req, res) => res.json({ serverTs: Date.now() }));
// Movement charts: every quote's recent history, downsampled (built at most once per 5 s, shared by all viewers)
let histCache = { at: 0, key: '', body: '' };
app.get('/api/history', (req, res) => {
  const hours = Math.min(72, Math.max(1, Number(req.query.hours) || 48)), points = Math.min(240, Math.max(10, Number(req.query.points) || 90));
  const key = `${hours}|${points}`;
  if (histCache.key !== key || Date.now() - histCache.at > 5000) histCache = { at: Date.now(), key, body: JSON.stringify(store.historyView({ hours, points })) };
  res.type('application/json').send(histCache.body);
});
app.get('/api/metrics', (req, res) => res.json({ version: VERSION, ...metrics.toJSON(), sources: store.sources, staleThresholdsMs: STALE_MS, sseBatchMs: BATCH_MS }));
// Liveness for the host (never fails because a BOOK is down — restarting us would not fix DraftKings).
app.get('/healthz', (req, res) => res.json({ ok: true, version: VERSION, games: store.games.size, quotes: store.quotes.size, clients: clients.size }));
// Readiness for monitoring: 503 unless both books are fresh and the board has games.
app.get('/api/health', (req, res) => {
  const now = Date.now();
  const books = Object.fromEntries(BOOKS.map((b) => {
    const s = store.sources[b];
    return [b, { state: s.state, mode: s.mode, region: s.region, stale: s.stale, dataAgeMs: s.lastDataAt ? now - s.lastDataAt : null, snapshotAgeMs: s.lastSnapshotAt ? now - s.lastSnapshotAt : null, snapshotVia: s.snapshotVia, quotes: [...store.quotes.values()].filter((q) => q.book === b).length, lastError: s.lastError }];
  }));
  const ok = store.games.size > 0 && BOOKS.every((b) => !books[b].stale && books[b].quotes > 0);
  res.status(ok ? 200 : 503).json({ ok, version: VERSION, games: store.games.size, books, clients: clients.size });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.socket?.setNoDelay(true); // small frames go out immediately (no Nagle delay)
  res.write(snapshotSse());
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

// ---------- DraftKings snapshot relay (edge machine → here, see src/edge.js) ----------
// The cloud holds DK's socket itself; what it cannot fetch is the REST snapshot (403 for datacenter IPs).
// An edge machine on an accepted IP sends the raw snapshot JSON every 30 s and whenever we ask.
let lastEdgeAt = 0;
function ingestSnapshot(body, now = Date.now()) {
  if (!dk) return { error: 'draftkings source disabled' };
  const { snapshot, edgeTs, rttMs } = body || {};
  if (!snapshot?.events) return { error: 'no snapshot' };
  lastEdgeAt = now; metrics.dk.relayMessages++;
  if (Number.isFinite(rttMs)) metrics.dk.relayRtt.push(rttMs);
  const n = dk.applySnapshot(snapshot, now, 'edge');
  store.setSource('draftkings', { lastError: null, relayRttMs: Number.isFinite(rttMs) ? rttMs : undefined, edgeLagMs: edgeTs ? now - edgeTs : undefined, detail: `${n.games} games, ${n.selections} prices, snapshot via edge` });
  return n;
}
const authorized = (h) => !!INGEST_TOKEN && h === `Bearer ${INGEST_TOKEN}`;
app.post('/ingest/dk-snapshot', (req, res) => {
  if (!authorized(req.headers.authorization)) return res.status(401).json({ error: 'bad token' });
  res.json({ ok: true, ...ingestSnapshot(req.body) });
});

// Diagnostics: can THIS server hold DraftKings' push socket? (socket host and REST host are different Akamai products)
app.get('/api/diag/dk-socket', async (req, res) => {
  const { probeDkSocket } = await import('../tools/probe-dk-ws.mjs');
  const out = {};
  for (const [region, siteName] of [['us-oh', 'dkusoh'], ['us-nj', 'dkusnj'], ['ca-on', 'dkcaon']]) out[region] = await probeDkSocket({ region, siteName, seconds: 5 });
  res.json(out);
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
const relay = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ingest/ws') return socket.destroy();
  if (!authorized(req.headers.authorization)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  relay.handleUpgrade(req, socket, head, (ws) => relay.emit('connection', ws, req));
});
relay.on('connection', (ws, req) => {
  ws._socket?.setNoDelay(true); edges.add(ws);
  log('relay', `edge connected from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
  if (dk?.restBlocked) ws.send(JSON.stringify({ type: 'need-snapshot', why: 'edge connected' }));
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    if (msg.type === 'snapshot') ingestSnapshot(msg);
    if (msg.type === 'fd-prices' && fd && Array.isArray(msg.markets)) {
      // the edge started its request ~RTT/2 after we sent the trigger
      const rtt = Number.isFinite(msg.rttMs) ? msg.rttMs : 0;
      fd.applyEdgePrices(msg.markets, msg.t + rtt / 2, Date.now());
    }
  });
  ws.on('close', () => { edges.delete(ws); log('relay', 'edge disconnected'); });
});

for (const s of sources) s.start().catch((e) => log('src', 'start failed', e));
const shutdown = async () => { for (const s of sources) s.stop(); await dk?.saveCheckpoint(); await saveHistory(); await checkpoint?.close(); server.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
