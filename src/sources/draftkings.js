// DraftKings worker.
//
// How the DK website gets odds (found with tools/capture-network.mjs, see research/findings.md):
//   1. ONE snapshot over HTTPS:   GET sportsbook-nash.draftkings.com/sites/<SITE>/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?...
//      → { events[], markets[], selections[] } for the league (88808 = NFL) and subcategory 4518 (= "Game Lines").
//   2. Then a WebSocket:  wss://sportsbook-ws-<region>.draftkings.com/websocket?format=msgpack
//      JSON-RPC "subscribe" with the same filters, initialData:false → the server pushes only CHANGES (deltas),
//      MessagePack-encoded, each stamped with DK's own createdTime/receivedTime/publishedTime.
//
// So DK is a "snapshot + deltas" feed. We keep the state ourselves: snapshot into the store, apply each delta
// by selection id, and re-snapshot periodically so a missed message can never leave the board wrong for long.
//
// Line moves: DK encodes the line in the selection id ("0HC84695615P350_3" = spread +3.5, away). When the line
// moves, the delta carries a NEW id. We map it instantly through its "family" (type + market number + outcome,
// e.g. "HC84695615_3") and read the new line from the id, so a line move reaches the screen as fast as a price move.
import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';
import { randomUUID } from 'node:crypto';
import { resolveTeam, gameKey, parseAmerican } from '../model.js';

const BOOK = 'draftkings';
const LEAGUE = '88808';          // NFL
const SUBCATEGORY = '4518';      // Game Lines (moneyline / spread / total)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MARKET_MAP = { Moneyline: 'moneyline', Spread: 'spread', Total: 'total' };
const LIVE_STATES = new Set(['STARTED', 'IN_PROGRESS', 'LIVE', 'INPLAY', 'IN_PLAY']);
const SITES = ['CA-ON-SB', 'US-OH-SB', 'US-NJ-SB', 'US-PA-SB', 'US-MI-SB', 'US-VA-SB', 'US-SB'];

export class DraftKingsSource {
  constructor(store, metrics, log, opts = {}) {
    this.store = store; this.metrics = metrics; this.log = log;
    // DK serves one site per licensed region and refuses other regions' sites by IP (403 from Akamai).
    // From Ontario only CA-ON-SB answers; from a US server it is the other way round. So we probe candidates
    // in order at startup and keep the first one that returns a snapshot. DK_SITE puts a preferred one first.
    const pref = opts.site || process.env.DK_SITE;
    this.candidates = opts.candidates || [...(pref ? [pref] : []), ...SITES].filter((s, i, a) => a.indexOf(s) === i)
      .map((site) => ({ site, siteName: siteNameFor(site), wsHost: wsHostFor(site) }));
    Object.assign(this, this.candidates[0]);
    // Overridable endpoints (tests point these at a local fake DraftKings).
    this.nashBase = opts.nashBase || process.env.DK_NASH_BASE || 'https://sportsbook-nash.draftkings.com';
    this.wsUrlOverride = opts.wsUrl || process.env.DK_WS_URL || null;
    this.resnapshotMs = Number(opts.resnapshotMs || process.env.DK_RESNAPSHOT_MS || 60_000);
    this.pingMs = Number(opts.pingMs || 30_000);
    this.selIndex = new Map();    // DK selection id -> { gameKey, market, side }
    this.familyIndex = new Map(); // "HC84695615_3" -> { gameKey, market, side } (survives line moves)
    this.eventIndex = new Map();  // DK event id -> gameKey
    this.ws = null; this.stopped = false; this.backoff = 1000; this.pendingResnap = null; this.pongTimer = null;
  }

  headers() {
    return { accept: 'application/json', 'accept-language': 'en-CA', referer: 'https://sportsbook.draftkings.com/', origin: 'https://sportsbook.draftkings.com',
      'user-agent': UA, 'x-client-name': 'web', 'x-client-version': '2643.4.1.10', 'x-client-page': 'league', 'x-client-feature': 'leagueSubcategory' };
  }

  async start() {
    this.store.setSource(BOOK, { mode: 'websocket', state: 'connecting', detail: 'probing regional sites' });
    const ok = await this.pickSite();   // also loads the first snapshot
    if (this.stopped) return;
    if (!ok) {
      // This server's IP is refused by every DK site (datacenter IPs are). Step aside: an edge worker (src/edge.js)
      // pushes DK data into /ingest instead. Re-probe every 10 minutes in case the block lifts.
      this.store.setSource(BOOK, { mode: 'websocket (via edge)', state: 'down', detail: 'this server\'s IP is refused by DraftKings (HTTP 403); waiting for edge worker' });
      this.retryTimer = setTimeout(() => this.start(), 10 * 60_000);
      return;
    }
    this.connect();
    this.timer = setInterval(() => this.snapshot().catch((e) => this.fail('resnapshot', e)), this.resnapshotMs);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer); clearTimeout(this.retryTimer); clearTimeout(this.pendingResnap); clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer); clearTimeout(this.pongTimer);
    this.ws?.terminate();
  }

  /** Try each regional site until one gives us a snapshot (geo-fencing is by IP, see README). */
  async pickSite() {
    for (const c of this.candidates) {
      Object.assign(this, c);
      try { await this.snapshot(); this.log('dk', `using site ${c.site} (${c.siteName}, ${c.wsHost})`); return true; }
      catch (e) { this.log('dk', `site ${c.site} rejected: ${String(e.message).split('\n')[0].slice(0, 60)}`); }
      if (this.stopped) return false;
    }
    this.log('dk', 'no DraftKings regional site accepted this server\'s IP');
    return false;
  }

  fail(where, e) {
    const msg = `${where}: ${e?.message || e}`;
    this.log('dk', msg);
    this.store.setSource(BOOK, { lastError: msg, state: this.ws?.readyState === WebSocket.OPEN ? 'live' : 'down' });
  }

  // ---------- 1) snapshot ----------
  snapshotUrl() {
    const q = new URLSearchParams({ isBatchable: 'false', templateVars: LEAGUE, include: 'Events', entity: 'events',
      eventsQuery: `$filter=leagueId eq '${LEAGUE}' AND clientMetadata/Subcategories/any(s: s/Id eq '${SUBCATEGORY}')`,
      marketsQuery: `$filter=clientMetadata/subCategoryId eq '${SUBCATEGORY}' AND tags/all(t: t ne 'SportcastBetBuilder')` });
    return `${this.nashBase}/sites/${this.site}/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?${q}`;
  }

  async snapshot() {
    const t0 = Date.now();
    const r = await fetch(this.snapshotUrl(), { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const data = await r.json();
    const now = Date.now();
    this.applySnapshot(data, now);
    this.metrics.dk.snapshots++;
    this.store.setSource(BOOK, { lastSnapshotAt: now, lastDataAt: now, lastError: null, detail: `${data.events?.length ?? 0} games, ${data.selections?.length ?? 0} prices, snapshot ${now - t0} ms` });
  }

  applySnapshot(data, now = Date.now()) {
    const games = new Map(); // dk eventId -> game
    for (const ev of data.events || []) {
      if (ev.eventParticipantType && ev.eventParticipantType !== 'TwoTeam') continue;
      const home = resolveTeam(ev.participants?.find((p) => p.venueRole === 'Home')?.name);
      const away = resolveTeam(ev.participants?.find((p) => p.venueRole === 'Away')?.name);
      if (!home || !away) continue;
      const key = gameKey(away, home, ev.startEventDate);
      const game = { key, home, away, start: ev.startEventDate, books: { [BOOK]: { eventId: ev.id, status: ev.status, live: LIVE_STATES.has(ev.status) } } };
      games.set(ev.id, game); this.eventIndex.set(ev.id, key);
      this.store.upsertGame(game);
    }
    const markets = new Map();
    for (const m of data.markets || []) {
      const market = MARKET_MAP[m.name] || MARKET_MAP[m.marketType?.name];
      const game = games.get(m.eventId);
      if (!market || !game) continue;
      markets.set(m.id, { market, game });
    }
    const seen = new Set();
    for (const s of data.selections || []) {
      const mk = markets.get(s.marketId); if (!mk) continue;
      const side = this.sideOf(mk.market, s, mk.game); if (!side) continue;
      const ref = { gameKey: mk.game.key, market: mk.market, side };
      this.selIndex.set(s.id, ref);
      const fam = familyOf(s.id); if (fam) this.familyIndex.set(fam, ref);
      seen.add(`${ref.gameKey}|${ref.market}|${ref.side}`);
      this.store.upsertQuote({ ...ref, book: BOOK, line: mk.market === 'moneyline' ? null : (s.points ?? lineFromId(s.id)), odds: parseAmerican(s.displayOdds?.american), sourceTs: null }, now);
    }
    // A market that disappeared from the snapshot (suspended / taken down) must not keep showing a stale price.
    if (games.size) for (const q of [...this.store.quotes.values()]) {
      if (q.book === BOOK && !seen.has(`${q.gameKey}|${q.market}|${q.side}`)) this.store.removeQuotes(BOOK, q.gameKey, q.market);
    }
  }

  sideOf(market, sel, game) {
    if (market === 'total') return sel.outcomeType === 'Over' ? 'over' : sel.outcomeType === 'Under' ? 'under' : (/^over/i.test(sel.label) ? 'over' : /^under/i.test(sel.label) ? 'under' : null);
    if (sel.outcomeType === 'Home') return 'home';
    if (sel.outcomeType === 'Away') return 'away';
    const t = resolveTeam(sel.label);
    return t ? (t.abbr === game.home.abbr ? 'home' : t.abbr === game.away.abbr ? 'away' : null) : null;
  }

  // ---------- 2) websocket deltas ----------
  wsUrl() { return this.wsUrlOverride || `wss://${this.wsHost}/websocket?format=msgpack&locale=en`; }

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.wsUrl(), { headers: { origin: 'https://sportsbook.draftkings.com', 'user-agent': UA }, handshakeTimeout: 15_000, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      ws.send(encode({ jsonrpc: '2.0', method: 'subscribe', id: randomUUID(), params: {
        entity: 'events',
        queryParams: { query: `$filter=leagueId eq '${LEAGUE}' AND clientMetadata/Subcategories/any(s: s/Id eq '${SUBCATEGORY}') and tags/any(t: t eq 'OSB')`,
          initialData: false, projection: 'sportsbook', locale: 'en',
          includeMarkets: `$filter=clientMetadata/subCategoryId eq '${SUBCATEGORY}' AND tags/all(t: t ne 'SportcastBetBuilder') and tags/any(t: t eq 'OSB')` },
        forwardedHeaders: {}, clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': '2643.4.1.10' },
        jwt: 'default-token', siteName: this.siteName } }));
      this.store.setSource(BOOK, { state: 'live', lastError: null, lastDataAt: Date.now() });
      this.log('dk', 'websocket open + subscribed');
      // Silence is normal on a delta feed (no line moved), so we ping to tell "quiet" from "dead".
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.ping();
        clearTimeout(this.pongTimer);
        this.pongTimer = setTimeout(() => { this.log('dk', 'no pong → reconnect'); ws.terminate(); }, Math.min(10_000, this.pingMs));
      }, this.pingMs);
    });
    // A pong proves the socket is alive even if no line moved, so the board must not call DK stale.
    ws.on('pong', () => { clearTimeout(this.pongTimer); this.store.setSource(BOOK, { lastDataAt: Date.now() }); });
    ws.on('message', (buf) => this.onMessage(buf));
    ws.on('error', (e) => this.fail('websocket', e));
    ws.on('close', (code) => {
      clearInterval(this.pingTimer); clearTimeout(this.pongTimer);
      if (this.stopped || this.ws !== ws) return;
      this.metrics.dk.reconnects++;
      this.store.setSource(BOOK, { state: 'down', reconnects: this.metrics.dk.reconnects, detail: `socket closed (${code}); reconnecting in ${this.backoff / 1000}s` });
      this.reconnectTimer = setTimeout(() => { this.connect(); this.snapshot().catch((e) => this.fail('snapshot-after-reconnect', e)); }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  /** Apply one WebSocket frame. Returns the number of prices that changed. */
  onMessage(buf, now = Date.now()) {
    this.metrics.dk.wsMessages++;
    let msg; try { msg = decode(buf); } catch { this.metrics.dk.decodeMisses++; return 0; }
    if (!Array.isArray(msg) || msg[1] !== 'update') return 0; // "subscribed" ack etc.
    this.store.setSource(BOOK, { lastDataAt: now, updates: this.metrics.dk.wsMessages });
    const stamp = findKey(msg, 'publishedTime');
    const sourceTs = stamp ? Date.parse(stamp) : null;
    let applied = 0, unknown = 0;
    // Deltas are compact positional arrays. We recognise the two shapes we need by their fields and ignore the rest.
    walk(msg[2], (a) => {
      if (typeof a[0] !== 'string') return;
      // selection update: [id, label, [american, decimal, ...], trueOdds, points, sortOrder, tags, metadata]
      if (Array.isArray(a[2]) && typeof a[2][0] === 'string' && /^[+−-]?\d+$/.test(a[2][0])) {
        let ref = this.selIndex.get(a[0]);
        if (!ref) {
          // New id = the line moved. Same family → same game/market/side; the line is in the id.
          const fam = familyOf(a[0]); ref = fam && this.familyIndex.get(fam);
          if (!ref) { unknown++; return; }
          this.selIndex.set(a[0], ref); this.metrics.dk.lineMovesMapped++; unknown++; // still refresh the snapshot later, as a cross-check
        }
        const line = ref.market === 'moneyline' ? null : (typeof a[4] === 'number' ? a[4] : lineFromId(a[0]));
        const odds = parseAmerican(a[2][0]);
        if (this.store.upsertQuote({ ...ref, book: BOOK, line, odds, sourceTs }, now)) {
          applied++;
          const game = this.store.games.get(ref.gameKey);
          if (sourceTs) (game?.status === 'live' ? this.metrics.dk.ingestLagLive : this.metrics.dk.ingestLagPregame).push(now - sourceTs);
        }
        return;
      }
      // event update: [eventId, startTime, participants, status, ...]
      if (this.eventIndex.has(a[0]) && typeof a[3] === 'string' && /^[A-Z_]+$/.test(a[3])) {
        const key = this.eventIndex.get(a[0]);
        const g = this.store.games.get(key);
        if (g) this.store.upsertGame({ key, books: { [BOOK]: { ...g.books[BOOK], status: a[3], live: LIVE_STATES.has(a[3]) } } });
      }
    });
    this.metrics.dk.selectionUpdates += applied;
    // Anything we could not place (or a mapped line move) → re-snapshot shortly as a correctness check, never as the fast path.
    if (unknown && !this.pendingResnap && !this.stopped) this.pendingResnap = setTimeout(() => { this.pendingResnap = null; this.snapshot().catch((e) => this.fail('resnapshot', e)); }, 3000);
    return applied;
  }
}

// "0HC84695615P350_3" → "HC84695615_3";  "0ML84695615_1" → "ML84695615_1";  "0OU84695615O4750_1" → "OU84695615_1"
export function familyOf(id) {
  const m = /^0(ML|HC|OU)(\d+)(?:[A-Z]\d+)?_(\d+)$/.exec(id || '');
  return m ? `${m[1]}${m[2]}_${m[3]}` : null;
}
// "0HC84695615P350_3" → 3.5;  "0HC…N350_1" → −3.5;  "0OU…O4750_1" → 47.5;  moneyline → null
export function lineFromId(id) {
  let m = /^0HC\d+([PN])(\d+)_\d+$/.exec(id || '');
  if (m) return (m[1] === 'N' ? -1 : 1) * Number(m[2]) / 100 || 0;
  m = /^0OU\d+[OU](\d+)_\d+$/.exec(id || '');
  return m ? Number(m[1]) / 100 : null;
}
// 'US-NJ-SB' -> 'dkusnj' / 'sportsbook-ws-us-nj.draftkings.com' (pattern observed on the Ontario site: CA-ON-SB -> dkcaon / sportsbook-ws-ca-on)
function siteNameFor(site) { return 'dk' + site.replace(/-SB$/, '').replace(/-/g, '').toLowerCase(); }
function wsHostFor(site) { return `sportsbook-ws-${site.replace(/-SB$/, '').toLowerCase()}.draftkings.com`; }

function walk(node, fn) {
  if (!Array.isArray(node)) return;
  fn(node);
  for (const x of node) if (Array.isArray(x)) walk(x, fn);
}
function findKey(node, key) {
  if (Array.isArray(node)) { for (const x of node) { const r = findKey(x, key); if (r) return r; } return null; }
  if (node && typeof node === 'object') { if (key in node) return node[key]; for (const v of Object.values(node)) { const r = findKey(v, key); if (r) return r; } }
  return null;
}
