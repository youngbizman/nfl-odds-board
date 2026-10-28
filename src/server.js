// HTTP server: serves the board UI, a JSON snapshot, and a Server-Sent Events stream of changes.
//
// Why SSE and not WebSocket for browsers: the browser only needs to LISTEN. SSE is one-way, plain HTTP,
// reconnects by itself (EventSource), and passes every proxy/CDN. One ingestion per book feeds one store;
// N browsers just subscribe to the store — adding viewers never adds requests to the books.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardStore } from './store.js';
import { Metrics } from './metrics.js';
import { DraftKingsSource } from './sources/draftkings.js';
import { FanDuelSource } from './sources/fanduel.js';
import { BOOKS } from './model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BATCH_MS = Number(process.env.SSE_BATCH_MS || 40);      // coalesce changes that land within 40 ms into one event
const STALE_MS = { draftkings: Number(process.env.DK_STALE_MS || 150_000), fanduel: Number(process.env.FD_STALE_MS || 15_000) };

const log = (tag, ...a) => console.log(new Date().toISOString(), `[${tag}]`, ...a);
const store = new BoardStore();
const metrics = new Metrics();
const sources = [new DraftKingsSource(store, metrics, log), new FanDuelSource(store, metrics, log)];

// ---------- SSE fan-out ----------
const clients = new Set();
let pending = { quotes: new Map(), games: new Map(), sources: new Map(), firstAt: null, timer: null };
function queue(kind, item, key) {
  pending[kind].set(key, item);
  if (!pending.firstAt) pending.firstAt = Date.now();
  if (!pending.timer) pending.timer = setTimeout(flush, BATCH_MS);
}
function flush() {
  const batch = { serverTs: Date.now(), quotes: [...pending.quotes.values()], games: [...pending.games.values()], sources: Object.fromEntries(pending.sources) };
  metrics.sse.coalesceWait.push(Date.now() - pending.firstAt);
  pending = { quotes: new Map(), games: new Map(), sources: new Map(), firstAt: null, timer: null };
  const payload = `event: batch\ndata: ${JSON.stringify(batch)}\n\n`;
  metrics.sse.batchesSent++; metrics.sse.batchSize.push(batch.quotes.length);
  for (const res of clients) { res.write(payload); metrics.sse.bytesSent += payload.length; }
}
store.on('quote', (q) => queue('quotes', q, q.id));
store.on('game', (g) => queue('games', g, g.key));
store.on('source', (s) => queue('sources', s, s.book));
setInterval(() => store.refreshStaleness(STALE_MS), 1000);
setInterval(() => { for (const res of clients) res.write(`: ping ${Date.now()}\n\n`); }, 15_000); // keep proxies from closing idle streams

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));

app.get('/api/board', (req, res) => res.json(store.snapshot()));
app.get('/api/time', (req, res) => res.json({ serverTs: Date.now() }));
app.get('/api/metrics', (req, res) => res.json({ ...metrics.toJSON(), sources: store.sources, staleThresholdsMs: STALE_MS, sseBatchMs: BATCH_MS }));
app.get('/healthz', (req, res) => res.json({ ok: true, games: store.games.size, quotes: store.quotes.size, clients: clients.size }));

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
  clients.add(res); metrics.sse.clients = clients.size;
  req.on('close', () => { clients.delete(res); metrics.sse.clients = clients.size; });
});

// Browsers report what they measured so the numbers in /api/metrics are true end-to-end, not server-only.
app.post('/api/report', (req, res) => {
  const { pushLag = {}, endToEnd = {} } = req.body || {};
  for (const b of BOOKS) for (const v of pushLag[b] || []) metrics.browser.pushLag[b].push(v);
  for (const phase of ['pregame', 'live']) for (const v of endToEnd.draftkings?.[phase] || []) metrics.browser.endToEnd.draftkings[phase].push(v);
  metrics.browser.reports++;
  res.json({ ok: true });
});

// ---------- edge ingestion (DraftKings collected elsewhere, see src/edge.js) ----------
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
let lastEdgeAt = 0;
app.post('/ingest/draftkings', (req, res) => {
  if (!INGEST_TOKEN || req.headers.authorization !== `Bearer ${INGEST_TOKEN}`) return res.status(401).json({ error: 'bad token' });
  const now = Date.now(); const { quotes = [], games = [], source, edgeTs } = req.body || {};
  lastEdgeAt = now;
  for (const g of games) if (g?.key) store.upsertGame(g);
  for (const q of quotes) {
    if (q?.book !== 'draftkings') continue;
    if (q.removed) { store.removeQuotes('draftkings', q.gameKey, q.market); continue; }
    // keep DK's publishedTime (sourceTs) and remember when the edge saw it, so latency can be split per hop
    store.upsertQuote({ gameKey: q.gameKey, market: q.market, side: q.side, book: q.book, line: q.line, odds: q.odds, suspended: q.suspended, sourceTs: q.sourceTs ?? null, edgeAt: q.updatedAt ?? null }, now);
    if (q.sourceTs) { const g = store.games.get(q.gameKey); (g?.status === 'live' ? metrics.dk.ingestLagLive : metrics.dk.ingestLagPregame).push(now - q.sourceTs); }
  }
  if (source) store.setSource('draftkings', { ...source, mode: 'websocket (via edge)', lastDataAt: now, edgeLagMs: edgeTs ? now - edgeTs : null });
  res.json({ ok: true, quotes: quotes.length });
});

// Diagnostics: what does DraftKings say to THIS server's IP? (documents geo / bot blocking honestly)
app.get('/api/diag/draftkings', async (req, res) => {
  const out = { serverTs: Date.now(), lastEdgeAt: lastEdgeAt || null, sites: {} };
  try { out.ip = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) })).json(); } catch (e) { out.ip = String(e); }
  for (const site of ['US-OH-SB', 'US-NJ-SB', 'CA-ON-SB']) {
    try {
      const r = await fetch(`https://sportsbook-nash.draftkings.com/sites/${site}/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?isBatchable=false&templateVars=88808&entity=events&include=Events&eventsQuery=%24filter%3DleagueId%20eq%20%2788808%27&marketsQuery=%24filter%3DclientMetadata%2FsubCategoryId%20eq%20%274518%27`, { headers: { accept: 'application/json', referer: 'https://sportsbook.draftkings.com/', 'x-client-name': 'web' }, signal: AbortSignal.timeout(8000) });
      const t = await r.text(); out.sites[site] = { status: r.status, akamaiRef: /Reference&#32;&#35;([\w.]+)/.exec(t)?.[1] || null, bytes: t.length };
    } catch (e) { out.sites[site] = { error: String(e) }; }
  }
  try { const r = await fetch('https://sportsbook.draftkings.com/leagues/football/nfl', { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }); out.page = { status: r.status, bytes: (await r.text()).length }; } catch (e) { out.page = String(e); }
  res.json(out);
});

app.listen(PORT, () => log('http', `listening on :${PORT}`));
for (const s of sources) s.start().catch((e) => log('src', 'start failed', e));
process.on('SIGTERM', () => { for (const s of sources) s.stop(); process.exit(0); });
