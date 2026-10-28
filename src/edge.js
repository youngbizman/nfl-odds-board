// Edge worker: runs the DraftKings collector from a network DK accepts (a residential IP in a licensed region)
// and forwards normalized changes to the cloud server, which serves the viewers.
//
// Why this exists: DraftKings' Akamai layer returns 403 to cloud/datacenter IPs for every regional site
// (see README → "What we hit"). FanDuel is fine from the cloud, so only the DK collector moves to the edge.
// The cloud server still tries DK directly first; the edge is used only when it has to be.
//
//   DK ──WS/REST──▶ [edge: DraftKingsSource → BoardStore] ──HTTPS POST /ingest/draftkings (batched)──▶ [cloud BoardStore] ──SSE──▶ browsers
//
// Usage:  CLOUD_URL=https://… INGEST_TOKEN=… node src/edge.js
import { BoardStore } from './store.js';
import { Metrics } from './metrics.js';
import { DraftKingsSource } from './sources/draftkings.js';

const CLOUD = (process.env.CLOUD_URL || '').replace(/\/$/, '');
const TOKEN = process.env.INGEST_TOKEN || '';
const BATCH_MS = Number(process.env.EDGE_BATCH_MS || 40);
if (!CLOUD || !TOKEN) { console.error('CLOUD_URL and INGEST_TOKEN are required'); process.exit(1); }

const log = (tag, ...a) => console.log(new Date().toISOString(), `[edge:${tag}]`, ...a);
const store = new BoardStore();
const metrics = new Metrics();
const dk = new DraftKingsSource(store, metrics, log);

let pending = { quotes: new Map(), games: new Map(), source: null, timer: null };
let sent = 0, failed = 0, lastOkAt = 0;
function queue(kind, item, key) {
  if (kind === 'source') pending.source = item; else pending[kind].set(key, item);
  if (!pending.timer) pending.timer = setTimeout(flush, BATCH_MS);
}
async function flush() {
  const body = { edgeTs: Date.now(), quotes: [...pending.quotes.values()], games: [...pending.games.values()], source: pending.source };
  pending = { quotes: new Map(), games: new Map(), source: null, timer: null };
  try {
    const r = await fetch(`${CLOUD}/ingest/draftkings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    sent++; lastOkAt = Date.now();
  } catch (e) { failed++; log('push', `failed: ${e.message} (${body.quotes.length} quotes)`); }
}
store.on('quote', (q) => queue('quotes', q, q.id));
store.on('game', (g) => queue('games', g, g.key));
store.on('source', (s) => queue('source', s));

// Every 20 s re-send the whole DK board so the cloud converges even if a push was lost or the cloud restarted.
setInterval(() => {
  for (const g of store.games.values()) queue('games', g, g.key);
  for (const q of store.quotes.values()) if (q.book === 'draftkings') queue('quotes', q, q.id);
  queue('source', { ...store.sources.draftkings });
}, 20_000);
setInterval(() => log('stat', `pushes ok=${sent} failed=${failed} lastOk=${lastOkAt ? Math.round((Date.now() - lastOkAt) / 1000) + 's ago' : 'never'} · dk ${store.sources.draftkings.state} · quotes ${store.quotes.size}`), 60_000);
dk.start().catch((e) => log('dk', 'start failed', e));
process.on('SIGTERM', () => { dk.stop(); process.exit(0); });
