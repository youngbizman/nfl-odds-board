// Edge worker = DraftKings snapshot provider + FanDuel's second poller.
//
// Why this exists: DraftKings' REST snapshot host returns 403 to cloud/datacenter IPs, while its push socket accepts
// them (two different Akamai products; see README → "What we hit"). So the cloud server holds DK's socket itself,
// and this small process, running on a machine DK accepts (a residential IP in a licensed region), fetches the
// REST snapshot and relays it over one open WebSocket: every EDGE_SNAPSHOT_MS (30 s) and whenever the cloud asks
// ("need-snapshot": on connect, after a reconnect, or when a push names an id the cloud cannot place).
//
//   DK REST ──▶ [edge] ══ /ingest/ws {type:'snapshot'} ══▶ [cloud: dk.applySnapshot] ◀── DK socket (direct) ──▶ browsers
//
// Nothing on DraftKings' price path passes through here: pushes go DK → cloud directly. If this process dies, the cloud
// keeps applying pushes to the board it has (and restores it from Redis after a restart).
//
// FanDuel: when the cloud sends {type:'fd-poll'} (half a beat after its own poll), this machine polls the same markets
// from its own IP and sends back only the markets whose answer changed. The board gets a fresh FanDuel answer every
// 0.5 s while each IP stays at one request per second. If this process dies, FanDuel falls back to the cloud's 1 s beat.
// Usage:  CLOUD_URL=https://… INGEST_TOKEN=… node src/edge.js
import WebSocket from 'ws';
import { BoardStore } from './store.js';
import { Metrics } from './metrics.js';
import { DraftKingsSource } from './sources/draftkings.js';
import { FanDuelSource, fanduelEndpoints } from './sources/fanduel.js';

const CLOUD = (process.env.CLOUD_URL || '').replace(/\/$/, '');
const TOKEN = process.env.INGEST_TOKEN || '';
const EVERY = Number(process.env.EDGE_SNAPSHOT_MS || 30_000);
if (!CLOUD || !TOKEN) { console.error('CLOUD_URL and INGEST_TOKEN are required'); process.exit(1); }

const log = (tag, ...a) => console.log(new Date().toISOString(), `[edge:${tag}]`, ...a);
const dk = new DraftKingsSource(new BoardStore(), new Metrics(), log); // used only for fetchSnapshot() + site probing

let ws = null, backoff = 500, rttMs = null, sent = 0, failed = 0, lastOkAt = 0, inFlight = false, site = null;

// ---------- FanDuel interleave: poll when the cloud says (half a beat after its own poll), send only what changed ----------
const fdHeaders = new Map(); // region -> headers (same as the cloud's FanDuel worker sends)
const lastMarket = new Map(); // marketId -> JSON of the last answer we saw, so unchanged markets are not re-sent
let fdPolls = 0, fdSent = 0, fdErrors = 0, fdBusy = false, fdPausedUntil = 0;
async function pollFanDuel(msg) {
  if (fdBusy || Date.now() < fdPausedUntil || !Array.isArray(msg.marketIds) || !msg.marketIds.length) return;
  fdBusy = true;
  try {
    const region = String(msg.region || 'ON').toUpperCase();
    if (!fdHeaders.has(region)) fdHeaders.set(region, new FanDuelSource(new BoardStore(), new Metrics(), () => {}, { region }).headers());
    const r = await fetch(`${fanduelEndpoints(region).prices}?priceHistory=0`, { method: 'POST', headers: { ...fdHeaders.get(region), 'content-type': 'application/json' }, body: JSON.stringify({ marketIds: msg.marketIds }), signal: AbortSignal.timeout(2500) });
    fdPolls++;
    if (r.status !== 200) { fdErrors++; if (r.status === 429 || r.status === 403) fdPausedUntil = Date.now() + 60_000; throw new Error(`HTTP ${r.status}`); }
    const changed = [];
    for (const m of await r.json()) { const j = JSON.stringify(m.runnerDetails); if (lastMarket.get(m.marketId) !== j) { lastMarket.set(m.marketId, j); changed.push(m); } }
    if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'fd-prices', t: msg.t, rttMs, markets: changed })); fdSent += changed.length; }
  } catch (e) { if (fdErrors % 20 === 1) log('fd', `interleave poll failed: ${e.message}`); }
  finally { fdBusy = false; }
}

async function pickSite() {
  for (const c of dk.candidates) { Object.assign(dk, c); try { await dk.fetchSnapshot(); site = c.site; log('dk', `snapshot host accepts this IP for ${c.site}`); return true; } catch (e) { log('dk', `${c.site}: ${String(e.message).slice(0, 60)}`); } }
  return false;
}

async function sendSnapshot(why) {
  if (inFlight) return; inFlight = true;
  try {
    const t0 = Date.now();
    const snapshot = await dk.fetchSnapshot();
    const body = JSON.stringify({ type: 'snapshot', why, edgeTs: Date.now(), rttMs, fetchMs: Date.now() - t0, snapshot });
    if (ws?.readyState === WebSocket.OPEN) ws.send(body);
    else { // socket down: plain HTTPS so the cloud still converges
      const r = await fetch(`${CLOUD}/ingest/dk-snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body, signal: AbortSignal.timeout(15_000) });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    }
    sent++; lastOkAt = Date.now();
  } catch (e) { failed++; log('snapshot', `${why}: failed: ${e.message}`); }
  finally { inFlight = false; }
}

function connect() {
  const sock = new WebSocket(`${CLOUD.replace(/^http/, 'ws')}/ingest/ws`, { headers: { authorization: `Bearer ${TOKEN}` }, perMessageDeflate: false, handshakeTimeout: 10_000 });
  ws = sock;
  sock.on('open', () => { backoff = 500; log('relay', 'connected'); sendSnapshot('connected'); ping(); });
  sock.on('message', (d) => { try { const m = JSON.parse(d); if (m.type === 'pong') rttMs = Date.now() - m.t; if (m.type === 'need-snapshot') sendSnapshot(`cloud asked (${m.why})`); if (m.type === 'fd-poll') pollFanDuel(m); } catch {} });
  sock.on('error', (e) => log('relay', `error: ${e.message}`));
  sock.on('close', () => { if (ws === sock) { ws = null; log('relay', `closed; reconnecting in ${backoff} ms`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15_000); } });
}
function ping() { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }

if (!(await pickSite())) { log('dk', 'no DraftKings site accepts this machine either; retrying in 60 s'); setInterval(async () => { if (!site && (await pickSite())) sendSnapshot('site found'); }, 60_000); }
connect();
setInterval(ping, 10_000);
setInterval(() => sendSnapshot('periodic'), EVERY);
setInterval(() => log('stat', `dk snapshots ok=${sent} failed=${failed} · fd interleave polls=${fdPolls} changed-markets-sent=${fdSent} errors=${fdErrors} · rtt=${rttMs ?? '—'} ms · site ${site}`), 60_000);
const shutdown = () => { ws?.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
