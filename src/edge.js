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
//
// BetMGM (EDGE_MGM=1, temporary fallback): BetMGM's API only answers a real browser page, and the cloud runs one itself.
// If the cloud's browser session cannot get answers (no Chromium there, or BetMGM refuses its IP), it sends
// {type:'mgm-need', on:true}; this machine then polls BetMGM through its own headless browser on the same beat and
// sends {type:'mgm-fixtures', league, data} until the cloud says {on:false}. The goal is cloud-only; this is a bridge.
// Usage:  CLOUD_URL=https://… INGEST_TOKEN=… [EDGE_MGM=1] node src/edge.js
import WebSocket from 'ws';
import { BoardStore } from './store.js';
import { Metrics } from './metrics.js';
import { DraftKingsSource } from './sources/draftkings.js';
import { FanDuelSource, fanduelEndpoints, chunk } from './sources/fanduel.js';
import { DK_SUBCATS, slimDk } from './extras.js';
import { dkExtrasUrl, DK_HEADERS } from './sources/draftkings-extras.js';
import { LEAGUES } from './leagues.js';

const CLOUD = (process.env.CLOUD_URL || '').replace(/\/$/, '');
const TOKEN = process.env.INGEST_TOKEN || '';
const EVERY = Number(process.env.EDGE_SNAPSHOT_MS || 30_000);
if (!CLOUD || !TOKEN) { console.error('CLOUD_URL and INGEST_TOKEN are required'); process.exit(1); }

const log = (tag, ...a) => console.log(new Date().toISOString(), `[edge:${tag}]`, ...a);
const dk = new DraftKingsSource(new BoardStore(), new Metrics(), log); // used only for fetchSnapshot() + site probing (Node, or browser-compatible after a 403)

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
    // same split as the cloud: FanDuel answers at most 80 markets per request, so ≤50 per request, all in parallel
    const answers = await Promise.all(chunk(msg.marketIds, 50).map(async (marketIds) => {
      const r = await fetch(`${fanduelEndpoints(region).prices}?priceHistory=0`, { method: 'POST', headers: { ...fdHeaders.get(region), 'content-type': 'application/json' }, body: JSON.stringify({ marketIds }), signal: AbortSignal.timeout(2500) });
      if (r.status !== 200) { if (r.status === 429 || r.status === 403) fdPausedUntil = Date.now() + 60_000; throw new Error(`HTTP ${r.status}`); }
      return r.json();
    })).catch((e) => { fdErrors++; throw e; });
    fdPolls++;
    const changed = [];
    for (const m of answers.flat()) { const j = JSON.stringify([m.marketStatus, m.runnerDetails]); if (lastMarket.get(m.marketId) !== j) { lastMarket.set(m.marketId, j); changed.push(m); } }
    if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'fd-prices', t: msg.t, rttMs, markets: changed })); fdSent += changed.length; }
  } catch (e) { if (fdErrors % 20 === 1) log('fd', `interleave poll failed: ${e.message}`); }
  finally { fdBusy = false; }
}

// ---------- BetMGM fallback: poll only while the cloud asks ----------
const MGM_ON = process.env.EDGE_MGM === '1';
const MGM_EVERY = Number(process.env.MGM_POLL_MS || 2000);
let mgmSession = null, mgmWanted = false, mgmTimer = null, mgmRot = 0, mgmSent = 0, mgmErrors = 0;
async function pollBetMGM() {
  if (!mgmWanted) return;
  const t0 = Date.now();
  try {
    if (!mgmSession) { const { BetMGMBrowser } = await import('./sources/betmgm-browser.js'); mgmSession = new BetMGMBrowser({ log }); }
    const others = Object.values(LEAGUES).filter((l) => l.mgm && l.id !== 'nfl');
    const leagues = [LEAGUES.nfl, ...(others.length ? [others[mgmRot++ % others.length]] : [])];
    for (const l of leagues) {
      const data = await mgmSession.fetchFixtures(l.mgm);
      if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'mgm-fixtures', league: l.id, t: Date.now(), data })); mgmSent++; }
    }
  } catch (e) { mgmErrors++; if (mgmErrors % 10 === 1) log('mgm', `poll failed: ${e.message}`); }
  if (mgmWanted) mgmTimer = setTimeout(pollBetMGM, Math.max(0, MGM_EVERY - (Date.now() - t0)));
}
function setMgmWanted(on, why) {
  if (!MGM_ON || on === mgmWanted) return;
  mgmWanted = on; clearTimeout(mgmTimer);
  log('mgm', on ? `cloud asked for BetMGM (${why || 'no reason given'}) → polling every ${MGM_EVERY} ms` : 'cloud reads BetMGM itself again → stopped');
  if (on) pollBetMGM(); else { mgmSession?.close(); mgmSession = null; }
}

// Ontario only (dk.site is always CA-ON-SB): if Ontario refuses this machine too, we send nothing rather than another region.
async function pickSite() {
  try { await dk.fetchSnapshot(); site = dk.site; log('dk', `snapshot host accepts this IP for ${dk.site}`); return true; }
  catch (e) { log('dk', `${dk.site}: ${String(e.message).slice(0, 60)}`); return false; }
}

async function sendSnapshot(why) {
  if (inFlight) return; inFlight = true;
  try {
    const t0 = Date.now();
    const snapshot = await dk.fetchSnapshot();
    const body = JSON.stringify({ type: 'snapshot', site: dk.site, why, edgeTs: Date.now(), rttMs, fetchMs: Date.now() - t0, snapshot });
    if (ws?.readyState === WebSocket.OPEN) ws.send(body);
    else { // socket down: plain HTTPS so the cloud still converges
      const r = await fetch(`${CLOUD}/ingest/dk-snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body, signal: AbortSignal.timeout(15_000) });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    }
    sent++; lastOkAt = Date.now();
  } catch (e) { failed++; log('snapshot', `${why}: failed: ${e.message}`); }
  finally { inFlight = false; }
}

// ---------- DraftKings "more lines" (alt lines, player props): one subcategory at a time, each every ~2 min ----------
const SUBS = Object.keys(DK_SUBCATS); const EXTRAS_EVERY = Number(process.env.EDGE_EXTRAS_MS || 120_000);
let xi = 0, xSent = 0, xFailed = 0, xBytes = 0;
async function sendExtras(sub = SUBS[xi++ % SUBS.length]) {
  if (!site || ws?.readyState !== WebSocket.OPEN || process.env.EXTRAS === '0') return;
  try {
    const body = JSON.stringify({ type: 'dk-extras', site, sub, data: slimDk(await dk.http.getJson(dkExtrasUrl(dk.nashBase, site, sub), DK_HEADERS, 20_000)) });
    if (ws?.readyState === WebSocket.OPEN) { ws.send(body); xSent++; xBytes += body.length; }
  } catch (e) { xFailed++; if (xFailed % 10 === 1) log('extras', `subcategory ${sub}: ${e.message}`); }
}
const sendAllExtras = async () => { for (const sub of SUBS) { await sendExtras(sub); await new Promise((r) => setTimeout(r, 1000)); } };

function connect() {
  const sock = new WebSocket(`${CLOUD.replace(/^http/, 'ws')}/ingest/ws`, { headers: { authorization: `Bearer ${TOKEN}` }, perMessageDeflate: false, handshakeTimeout: 10_000 });
  ws = sock;
  sock.on('open', () => { backoff = 500; log('relay', 'connected'); sendSnapshot('connected'); ping(); setTimeout(sendAllExtras, 3000); });
  sock.on('message', (d) => { try { const m = JSON.parse(d); if (m.type === 'pong') rttMs = Date.now() - m.t; if (m.type === 'need-snapshot') sendSnapshot(`cloud asked (${m.why})`); if (m.type === 'fd-poll') pollFanDuel(m); if (m.type === 'mgm-need') setMgmWanted(!!m.on, m.why); } catch {} });
  sock.on('error', (e) => log('relay', `error: ${e.message}`));
  sock.on('close', () => { if (ws === sock) { setMgmWanted(false); ws = null; log('relay', `closed; reconnecting in ${backoff} ms`); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15_000); } });
}
function ping() { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }

if (!(await pickSite())) { log('dk', 'the Ontario snapshot host refuses this machine too; retrying in 60 s'); setInterval(async () => { if (!site && (await pickSite())) sendSnapshot('site found'); }, 60_000); }
connect();
setInterval(ping, 10_000);
setInterval(() => sendSnapshot('periodic'), EVERY);
setInterval(() => sendExtras(), EXTRAS_EVERY / SUBS.length);
setInterval(() => log('stat', `dk snapshots ok=${sent} failed=${failed} · fd interleave polls=${fdPolls} changed-markets-sent=${fdSent} errors=${fdErrors} · extras sent=${xSent} failed=${xFailed} ${Math.round(xBytes / 1e6)} MB · rtt=${rttMs ?? '—'} ms · site ${site}`), 60_000);
setInterval(() => { if (MGM_ON) log('stat', `betmgm ${mgmWanted ? 'polling for the cloud' : 'idle (cloud reads it itself)'} · sent=${mgmSent} errors=${mgmErrors}`); }, 60_000);
const shutdown = async () => { ws?.close(); await mgmSession?.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
