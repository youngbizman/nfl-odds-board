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
import { ExtrasStore, KINDS } from './extras.js';
import { DraftKingsExtras } from './sources/draftkings-extras.js';
import { FanDuelExtras } from './sources/fanduel-extras.js';
import { makeHttp } from './transport/http.js';
import { LEAGUES, LEAGUE_IDS, leagueOf, enabledLeagues } from './leagues.js';

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
// One HTTPS client for every DraftKings snapshot (game lines + more lines): Node first, browser-compatible after a 403.
const dkHttp = makeHttp({ log });
const dk = SOURCES.includes('draftkings') ? new DraftKingsSource(store, metrics, log, { onNeedSnapshot: askEdgeForSnapshot, checkpoint, http: dkHttp }) : null;
const fd = SOURCES.includes('fanduel') ? new FanDuelSource(store, metrics, log, { onMidBeat: askEdgeToPollFanDuel }) : null;
if (dk) sources.push(dk);
if (fd) sources.push(fd);
// "More lines" (alt lines + player props): separate store, workers and per-game streams, so they never slow the board.
const extras = new ExtrasStore();
const extraStreams = new Map(); // gameKey -> Set(res): viewers with that game's drop-down open
const watchedGames = () => new Set([...extraStreams].filter(([, set]) => set.size).map(([k]) => k));
const EXTRAS = process.env.EXTRAS !== '0';
const dkx = EXTRAS && dk ? new DraftKingsExtras(extras, store, log, { http: dkHttp }) : null;
const fdx = EXTRAS && fd ? new FanDuelExtras(extras, store, log, { region: fd.region, headers: () => fd.headers(), watched: watchedGames }) : null;
// Price history for the movement charts survives restarts in the same Redis (one JSON value, saved every minute).
const HISTORY_KEY = 'board:history';
if (checkpoint) try { const h = await checkpoint.loadBlob(HISTORY_KEY); if (h) { store.importHistory(JSON.parse(h)); log('history', `restored ${store.history.size} series`); } } catch (e) { log('history', `restore failed: ${e.message}`); }
const saveHistory = () => checkpoint?.saveBlob(HISTORY_KEY, JSON.stringify(store.exportHistory())).catch((e) => log('history', `save failed: ${e.message}`));
setInterval(saveHistory, 60_000);

// ---------- SSE fan-out ----------
const clients = new Map(); // res -> league the viewer is looking at (each viewer gets only that league's games)
const LEAGUES_ON = enabledLeagues().map((l) => l.id);
const leagueParam = (q) => (LEAGUES[String(q || '').toLowerCase()] ? String(q).toLowerCase() : 'nfl');
let pending = { quotes: new Map(), games: new Map(), sources: new Map(), firstAt: null, scheduled: false };
function queue(kind, item, key) {
  pending[kind].set(key, item);
  if (!pending.firstAt) pending.firstAt = Date.now();
  if (!pending.scheduled) { pending.scheduled = true; BATCH_MS > 0 ? setTimeout(flush, BATCH_MS) : setImmediate(flush); }
}
function flush() {
  const serverTs = Date.now(), quotes = [...pending.quotes.values()], games = [...pending.games.values()], sources = Object.fromEntries(pending.sources);
  metrics.sse.coalesceWait.push(Date.now() - pending.firstAt);
  pending = { quotes: new Map(), games: new Map(), sources: new Map(), firstAt: null, scheduled: false };
  const payloads = new Map(); // built once per league, only for leagues someone is watching
  const payloadFor = (lg) => {
    if (!payloads.has(lg)) {
      const q = quotes.filter((x) => leagueOf(x.gameKey) === lg), g = games.filter((x) => leagueOf(x.key) === lg);
      payloads.set(lg, q.length || g.length || Object.keys(sources).length ? `event: batch\ndata: ${JSON.stringify({ serverTs, quotes: q, games: g, sources })}\n\n` : null);
    }
    return payloads.get(lg);
  };
  metrics.sse.batchesSent++; metrics.sse.batchSize.push(quotes.length);
  for (const [res, lg] of clients) { const p = payloadFor(lg); if (p) { res.write(p); metrics.sse.bytesSent += p.length; } }
}
store.on('quote', (q) => queue('quotes', q, q.id));
store.on('game', (g) => queue('games', g, g.key));
store.on('source', (s) => queue('sources', s, s.book));
setInterval(() => store.refreshStaleness(STALE_MS), 1000);
setInterval(() => { // live latency figures for the feed cards (ride the heartbeat below)
  const dkLag = metrics.dk.ingestLagLive.stats().count ? metrics.dk.ingestLagLive.stats() : metrics.dk.ingestLagPregame.stats();
  store.sources.draftkings.lagP50Ms = dkLag.p50 ?? null; store.sources.draftkings.lagCount = dkLag.count;
  store.sources.fanduel.freshP50Ms = metrics.fd.freshInterval.stats().p50 ?? null;
  const fdPush = metrics.fd.pushLag.stats(); store.sources.fanduel.pushLagP50Ms = fdPush.p50 ?? null; store.sources.fanduel.pushLagCount = fdPush.count;
}, 5_000);
setInterval(() => { // status heartbeat: "data 3 s ago" counters, and keeps proxies from closing idle streams
  const payload = `event: batch\ndata: ${JSON.stringify({ serverTs: Date.now(), quotes: [], games: [], sources: store.sources })}\n\n`;
  for (const res of clients.keys()) res.write(payload);
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
  for (const res of clients.keys()) res.write(payload);
}, 100);

// per-game "more lines" stream: everything one upstream message changed for that game, in one event
const rowOut = (r) => ({ key: r.key, kind: r.kind, subject: r.subject, name: r.name, line: r.line, offers: r.offers });
let xPending = new Map(), xScheduled = false;
extras.on('row', (row) => {
  if (!extraStreams.get(row.gameKey)?.size) return;
  xPending.set(row.key, row);
  if (!xScheduled) { xScheduled = true; setImmediate(flushExtras); }
});
function flushExtras() {
  xScheduled = false; const byGame = new Map();
  for (const r of xPending.values()) { if (!byGame.has(r.gameKey)) byGame.set(r.gameKey, []); byGame.get(r.gameKey).push(rowOut(r)); }
  xPending = new Map();
  for (const [gk, rows] of byGame) { const payload = `event: rows\ndata: ${JSON.stringify({ serverTs: Date.now(), rows })}\n\n`; for (const res of extraStreams.get(gk) || []) res.write(payload); }
}
// every 2 s: each book's data age for the open drop-downs (also keeps proxies from closing idle streams)
setInterval(() => { const payload = `event: status\ndata: ${JSON.stringify(extras.status)}\n\n`; for (const set of extraStreams.values()) for (const res of set) res.write(payload); }, 2_000);

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));
// the browser uses the exact same comparison rules the tests check
app.get('/lib/model.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'model.js')));

/** The board for one league (or every league with league=all), plus which leagues exist and how many games each has. */
function snapshot(league = 'nfl') {
  const s = store.snapshot(); const pick = (k) => league === 'all' || leagueOf(k) === league;
  const counts = Object.fromEntries(LEAGUES_ON.map((id) => [id, 0])); for (const g of s.games) if (counts[leagueOf(g.key)] != null) counts[leagueOf(g.key)]++;
  return { ...s, league, games: s.games.filter((g) => pick(g.key)), quotes: s.quotes.filter((q) => pick(q.gameKey)),
    leagues: LEAGUES_ON.map((id) => ({ id, label: LEAGUES[id].label, title: LEAGUES[id].title, games: counts[id] })), config: { staleMs: STALE_MS, batchMs: BATCH_MS } };
}
// The snapshot is ~100 KB per league; serialising it per viewer would make a burst of joins CPU-bound. Serialise once per change.
let boardVersion = 0; const snapCache = new Map(); // league -> { version, sse }
for (const ev of ['quote', 'game', 'source']) store.on(ev, () => boardVersion++);
function snapshotSse(league) {
  const c = snapCache.get(league);
  if (c?.version === boardVersion) return c.sse;
  const sse = `retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(snapshot(league))}\n\n`;
  snapCache.set(league, { version: boardVersion, sse }); return sse;
}
app.get('/api/board', (req, res) => res.json(snapshot(req.query.league === 'all' ? 'all' : leagueParam(req.query.league))));
app.get('/api/time', (req, res) => res.json({ serverTs: Date.now() }));
app.get('/api/extras/summary', (req, res) => res.json({ kinds: KINDS, games: extras.summary(), holds: extras.holds(8), status: extras.status }));
app.get('/api/extras', (req, res) => { const gk = String(req.query.game || ''); res.json({ gameKey: gk, kinds: KINDS, rows: extras.forGame(gk).map(rowOut), status: extras.status, serverTs: Date.now() }); });
app.get('/api/extras/stream', (req, res) => {
  const gk = String(req.query.game || ''); if (!store.games.has(gk)) return res.status(404).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.socket?.setNoDelay(true);
  res.write(`event: snapshot\ndata: ${JSON.stringify({ gameKey: gk, kinds: KINDS, rows: extras.forGame(gk).map(rowOut), status: extras.status, serverTs: Date.now() })}\n\n`);
  if (!extraStreams.has(gk)) extraStreams.set(gk, new Set());
  extraStreams.get(gk).add(res);
  if (fdx && extraStreams.get(gk).size === 1) fdx.tick().catch(() => {}); // first viewer: refresh FanDuel's prices for this game now
  req.on('close', () => extraStreams.get(gk)?.delete(res));
});
// Movement charts: every quote's recent history, downsampled (built at most once per 5 s, shared by all viewers)
let histCache = { at: 0, key: '', body: '' };
app.get('/api/history', (req, res) => {
  // one game in detail (its page: up to a week, last 6 h at full resolution), or a league's board (downsampled)
  const game = String(req.query.game || '');
  if (game) {
    if (!store.games.has(game)) return res.status(404).json({ error: 'unknown game' });
    const hours = Math.min(192, Math.max(0.1, Number(req.query.hours) || 168));
    return res.json(store.historyView({ hours, points: 600, recentHours: Math.min(hours, 6), recentMax: 3000, only: (id) => id.startsWith(`${game}|`) }));
  }
  const hours = Math.min(72, Math.max(1, Number(req.query.hours) || 48)), points = Math.min(240, Math.max(10, Number(req.query.points) || 90));
  const league = leagueParam(req.query.league), key = `${hours}|${points}|${league}`;
  if (histCache.key !== key || Date.now() - histCache.at > 5000) {
    const v = store.historyView({ hours, points });
    for (const id of Object.keys(v.series)) if (leagueOf(id) !== league) delete v.series[id];
    histCache = { at: Date.now(), key, body: JSON.stringify(v) };
  }
  res.type('application/json').send(histCache.body);
});
app.get('/api/metrics', (req, res) => res.json({ version: VERSION, ...metrics.toJSON(), sources: store.sources, staleThresholdsMs: STALE_MS, sseBatchMs: BATCH_MS,
  keepalive: { url: SELF_URL || null, ...keepalive },
  transport: { draftkings: dkHttp.stats, fanduelPush: fd?.push ? { state: fd.push.state, ...fd.push.counts, subscribed: fd.push.subscribedCount() } : null }, edgeConnected: edges.size > 0, edgeIgnored,
  extras: { rows: extras.rows.size, status: extras.status, draftkings: dkx?.counts, fanduel: fdx?.counts, watched: [...watchedGames()] } }));
// Liveness for the host (never fails because a BOOK is down — restarting us would not fix DraftKings).
app.get('/healthz', (req, res) => res.json({ ok: true, version: VERSION, games: store.games.size, quotes: store.quotes.size, clients: clients.size }));
// Readiness for monitoring: 503 unless both books are fresh and the board has games.
app.get('/api/health', (req, res) => {
  const now = Date.now();
  const books = Object.fromEntries(BOOKS.map((b) => {
    const s = store.sources[b];
    return [b, { state: s.state, mode: s.mode, region: s.region, transport: s.transport, push: s.push, stale: s.stale, dataAgeMs: s.lastDataAt ? now - s.lastDataAt : null, snapshotAgeMs: s.lastSnapshotAt ? now - s.lastSnapshotAt : null, snapshotVia: s.snapshotVia, quotes: [...store.quotes.values()].filter((q) => q.book === b).length, lastError: s.lastError }];
  }));
  const nflGames = [...store.games.keys()].filter((k) => leagueOf(k) === 'nfl').length;
  const leagues = Object.fromEntries(LEAGUES_ON.map((id) => [id, { games: [...store.games.keys()].filter((k) => leagueOf(k) === id).length,
    quotes: Object.fromEntries(BOOKS.map((b) => [b, [...store.quotes.values()].filter((q) => q.book === b && leagueOf(q.gameKey) === id).length])) }]));
  const ok = nflGames > 0 && BOOKS.every((b) => !books[b].stale && books[b].quotes > 0);
  res.status(ok ? 200 : 503).json({ ok, version: VERSION, games: nflGames, books, leagues, clients: clients.size });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.socket?.setNoDelay(true); // small frames go out immediately (no Nagle delay)
  const league = leagueParam(req.query.league);
  res.write(snapshotSse(league));
  clients.set(res, league); metrics.sse.clients = clients.size;
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
let lastEdgeAt = 0, edgeIgnored = 0;
// The edge is a fallback: while this server fetches its own snapshots, an edge snapshot is counted and dropped, so
// "the cloud runs on its own" stays true and checkable (edgeIgnored in /api/metrics).
const ownSnapshotsWork = () => dk && !dk.restBlocked && store.sources.draftkings.snapshotVia === 'direct' && Date.now() - (store.sources.draftkings.lastSnapshotAt || 0) < 3 * dk.resnapshotMs;
function ingestSnapshot(body, now = Date.now()) {
  if (!dk) return { error: 'draftkings source disabled' };
  const { snapshot, edgeTs, rttMs } = body || {};
  if (!snapshot?.events) return { error: 'no snapshot' };
  if (ownSnapshotsWork()) { edgeIgnored++; return { ignored: 'this server fetches its own snapshots' }; }
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

// Render's free plan stops an instance after 15 minutes without inbound requests, and a stopped instance takes ~1 min
// to wake for the next viewer. Open viewer streams and the edge's relay socket used to keep it awake; with neither, the
// server calls its own public address every 4 minutes. That request goes out through Render's front door, so it counts.
const SELF_URL = (process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const keepalive = { ok: 0, failed: 0, lastAt: null };
if (SELF_URL && process.env.KEEPALIVE !== '0') setInterval(() => {
  fetch(`${SELF_URL}/healthz`, { signal: AbortSignal.timeout(15_000) }).then((r) => { keepalive.ok++; keepalive.lastAt = Date.now(); r.body?.cancel(); }).catch(() => keepalive.failed++);
}, 4 * 60_000);

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
    if (msg.type === 'dk-extras' && dkx && msg.data) { if (dkx.restBlocked) dkx.applySnapshot(String(msg.sub), msg.data, Date.now(), 'edge'); else edgeIgnored++; }
    if (msg.type === 'fd-prices' && fd && Array.isArray(msg.markets)) {
      // the edge started its request ~RTT/2 after we sent the trigger
      const rtt = Number.isFinite(msg.rttMs) ? msg.rttMs : 0;
      fd.applyEdgePrices(msg.markets, msg.t + rtt / 2, Date.now());
    }
  });
  ws.on('close', () => { edges.delete(ws); log('relay', 'edge disconnected'); });
});

for (const s of sources) s.start().catch((e) => log('src', 'start failed', e));
for (const x of [dkx, fdx]) x?.start().catch((e) => log('extras', 'start failed', e));
const shutdown = async () => { for (const s of sources) s.stop(); dkx?.stop(); fdx?.stop(); dkHttp.stop(); await dk?.saveCheckpoint(); await saveHistory(); await checkpoint?.close(); server.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
