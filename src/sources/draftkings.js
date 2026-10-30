// DraftKings worker.
//
// How the DK website gets odds (found with tools/capture-network.mjs, see research/findings.md):
//   1. ONE snapshot over HTTPS:   GET sportsbook-nash.draftkings.com/sites/<SITE>/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?...
//      → { events[], markets[], selections[] } for the league (88808 = NFL) and subcategory 4518 (= "Game Lines").
//   2. Then a WebSocket:  wss://sportsbook-ws-<region>.draftkings.com/websocket?format=json
//      JSON-RPC "subscribe" with the same filters, initialData:false → the server pushes only CHANGES:
//      { add, change, remove } × { events, markets, selections }, each frame stamped with DK's own publishedTime.
//
// Two different Akamai products sit in front of those hosts. The socket host accepts cloud IPs. The snapshot host
// refuses Node's own HTTPS client from cloud IPs (403) but accepts a client with a browser's TLS/HTTP2 handshake,
// so snapshots go through src/transport/http.js: Node first, the browser-compatible client after the first 403.
// That makes the cloud server self-sufficient. An edge machine (src/edge.js → /ingest/dk-snapshot) is only a
// fallback if both clients are refused. The socket is not geo-fenced: the site name only selects which site's prices.
//
// Ontario only. Every snapshot URL, socket subscription and restored checkpoint is the Ontario site (CA-ON-SB),
// the same jurisdiction as the FanDuel feed. If Ontario's snapshot host refuses us we say so and wait for an Ontario
// snapshot from the edge; we never fill the board from another region's prices.
//
// Availability: DraftKings marks a market closed with `isSuspended: true` (a selection can carry it too). Snapshots
// and `add` frames carry full objects (no flag = open); `change` frames are partial (no flag = unchanged). A
// suspension or reopening can arrive on its own, as a market-only `change`, with no price change at all.
//
// Line moves: DK encodes the line in the selection id ("0HC84695615P350_3" = spread +3.5, away). A move arrives as
// remove(old id) + add(new id, with marketId and points) and is applied immediately. If a change names an id we
// cannot place, we ask for a fresh snapshot (3 s debounce) as a correctness check, never as the fast path.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { parseAmerican } from '../model.js';
import { enabledLeagues, leagueGameKey, leagueOf, DK_LEAGUE, LEAGUES } from '../leagues.js';
import { makeHttp } from '../transport/http.js';

const BOOK = 'draftkings';
const SUBCATEGORY = '4518';      // Game Lines (moneyline / spread / total), the same id in every football league
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MARKET_MAP = { Moneyline: 'moneyline', Spread: 'spread', Total: 'total' };
const LIVE_STATES = new Set(['STARTED', 'IN_PROGRESS', 'LIVE', 'INPLAY', 'IN_PLAY']);
export const ONTARIO = 'CA-ON-SB';
const SIDES = { moneyline: ['home', 'away'], spread: ['home', 'away'], total: ['over', 'under'] };

/** Is this DraftKings market/selection closed? true / false when the object says so, undefined when it does not. */
export function closedFlag(o) {
  if (!o || typeof o !== 'object') return undefined;
  if (o.isSuspended === true || o.isOpen === false) return true;
  const st = typeof o.status === 'string' ? o.status.toUpperCase() : null;
  if (st === 'SUSPENDED' || st === 'CLOSED') return true;
  if (o.isSuspended === false || o.isOpen === true || st === 'OPEN' || st === 'ACTIVE') return false;
  return undefined;
}

/** The site this process may use: always Ontario. Anything else in the configuration is refused, loudly. */
export function ontarioSite(wanted, log) {
  if (wanted && wanted !== ONTARIO) log?.('dk', `DK_SITE=${wanted} ignored: this board shows Ontario prices only (${ONTARIO})`);
  return ONTARIO;
}

export class DraftKingsSource {
  constructor(store, metrics, log, opts = {}) {
    this.store = store; this.metrics = metrics; this.log = log;
    // Ontario for the snapshot, the socket subscription and the checkpoint: the same jurisdiction as our FanDuel feed.
    this.site = ontarioSite(opts.site || process.env.DK_SITE, log);
    this.siteName = siteNameFor(this.site); this.wsHost = wsHostFor(this.site);
    this.nashBase = opts.nashBase || process.env.DK_NASH_BASE || 'https://sportsbook-nash.draftkings.com';
    this.wsUrlOverride = opts.wsUrl || process.env.DK_WS_URL || null;
    this.leagues = opts.leagues || enabledLeagues(); // NFL first; college football and the CFL from the same hosts
    this.resnapshotMs = Number(opts.resnapshotMs || process.env.DK_RESNAPSHOT_MS || 30_000); // a reconciliation check; the socket carries every change
    this.http = opts.http || makeHttp({ log });
    this.pingMs = Number(opts.pingMs || 10_000); // proof of life when no price moves (DK only sends changes)
    this.selIndex = new Map();    // DK selection id -> { gameKey, market, side, marketId }
    this.familyIndex = new Map(); // "HC84695615_3" -> { gameKey, market, side, marketId } (survives line moves)
    this.marketIndex = new Map(); // DK market id -> { gameKey, market, suspended }
    this.quoteSel = new Map();    // our quote id -> { marketId, closed }: which DK market feeds it, and its selection's own flag
    this.eventIndex = new Map();  // DK event id -> gameKey
    this.restBlocked = false;     // this machine's IP is refused by the snapshot host → snapshots come from the edge
    this.onNeedSnapshot = opts.onNeedSnapshot || null; // called when we want a fresh snapshot but cannot fetch one
    this.checkpoint = opts.checkpoint || null;         // durable board + frame log (src/checkpoint.js)
    this.seq = 0; this.replaying = false;
    this.clock = null;                                 // { offsetMs, rttMs }: DK clock − our clock, from the subscribe ack
    this.ws = null; this.stopped = false; this.backoff = 1000; this.pendingResnap = null; this.pongTimer = null;
  }

  headers() {
    return { accept: 'application/json', 'accept-language': 'en-CA', referer: 'https://sportsbook.draftkings.com/', origin: 'https://sportsbook.draftkings.com',
      'user-agent': UA, 'x-client-name': 'web', 'x-client-version': '2643.4.1.10', 'x-client-page': 'league', 'x-client-feature': 'leagueSubcategory' };
  }

  async start() {
    this.store.setSource(BOOK, { mode: 'websocket', state: 'connecting', region: regionLabel(this.site), detail: 'probing snapshot access' });
    await this.restore();               // board from the durable checkpoint + frame log, if there is one
    const ok = await this.firstSnapshot(); // loads the first Ontario snapshot when this IP is allowed
    if (this.stopped) return;
    if (!ok) {
      this.restBlocked = true; // the Ontario socket is open to everyone; only the Ontario snapshot must come from the edge
      const restored = this.store.sources[BOOK]?.snapshotVia === 'checkpoint';
      this.store.setSource(BOOK, { mode: 'websocket', region: regionLabel(this.site), ...(restored ? {} : { snapshotVia: 'edge' }), detail: `Ontario snapshot host refuses this server; Ontario socket direct, ${restored ? 'board restored from an Ontario checkpoint, ' : ''}waiting for an Ontario snapshot from the edge (no other region is used)` });
      this.log('dk', `Ontario snapshot host refuses this server → Ontario socket direct (${this.wsHost}), waiting for an Ontario snapshot from the edge`);
    } else this.store.setSource(BOOK, { snapshotVia: 'direct' });
    this.connect();
    this.timer = setInterval(() => this.refreshSnapshot('periodic'), this.resnapshotMs);
    if (this.checkpoint) this.saveTimer = setInterval(() => this.saveCheckpoint(), 60_000);
  }

  // ---------- durability ----------
  exportState() {
    const games = [...this.store.games.values()].filter((g) => g.books?.[BOOK]);
    const quotes = [...this.store.quotes.values()].filter((q) => q.book === BOOK);
    return { v: 1, savedAt: Date.now(), seq: this.seq, site: this.site, games, quotes,
      selIndex: [...this.selIndex], familyIndex: [...this.familyIndex], eventIndex: [...this.eventIndex], quoteSel: [...this.quoteSel],
      marketIndex: [...this.marketIndex].map(([id, r]) => [id, { market: r.market, gameKey: r.gameKey, suspended: !!r.suspended }]) };
  }

  importState(st) {
    // a checkpoint is only trusted if it was written from the Ontario feed
    if (st.site !== ONTARIO) throw new Error(`checkpoint is from site ${st.site || 'unknown'}, not ${ONTARIO}; ignored`);
    for (const g of st.games || []) this.store.upsertGame(g);
    for (const q of st.quotes || []) this.store.upsertQuote(q, q.updatedAt || st.savedAt);
    this.selIndex = new Map(st.selIndex); this.familyIndex = new Map(st.familyIndex); this.eventIndex = new Map(st.eventIndex);
    this.marketIndex = new Map(st.marketIndex); this.quoteSel = new Map(st.quoteSel || []);
    this.seq = st.seq || 0;
  }

  async restore() {
    if (!this.checkpoint) return;
    try {
      const { state, frames } = await this.checkpoint.load();
      if (!state) return;
      this.importState(state);
      const newer = frames.filter((f) => f.seq > state.seq).sort((a, b) => a.seq - b.seq);
      this.replaying = true;
      for (const f of newer) { this.onMessage(Buffer.from(f.frame), f.ts); this.seq = Math.max(this.seq, f.seq); }
      this.replaying = false;
      this.seq = Math.max(this.seq, ...frames.map((f) => f.seq), 0);
      this.store.setSource(BOOK, { lastSnapshotAt: state.savedAt, snapshotVia: 'checkpoint', detail: `restored ${state.quotes?.length ?? 0} prices from checkpoint + ${newer.length} frames` });
      this.log('dk', `restored board from checkpoint (${Math.round((Date.now() - state.savedAt) / 1000)} s old) + ${newer.length} frames`);
    } catch (e) { this.replaying = false; this.log('dk', `checkpoint restore failed: ${e.message}`); }
  }

  saveCheckpoint() {
    if (!this.checkpoint || !this.selIndex.size) return Promise.resolve();
    return this.checkpoint.save(this.exportState()).catch((e) => this.log('dk', `checkpoint save failed: ${e.message}`));
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer); clearInterval(this.saveTimer); clearTimeout(this.pendingResnap); clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer); clearTimeout(this.pongTimer);
    this.ws?.terminate();
  }

  /** The first Ontario snapshot (the snapshot host is fenced by IP, see README). No other region is tried. */
  async firstSnapshot() {
    try { await this.snapshot(); this.log('dk', `snapshot ok from ${this.site} (${this.siteName}, ${this.wsHost})`); return true; }
    catch (e) { this.log('dk', `Ontario snapshot (${this.site}) refused: ${String(e.message).split('\n')[0].slice(0, 60)}`); return false; }
  }

  fail(where, e) {
    const msg = `${where}: ${e?.message || e}`;
    this.log('dk', msg);
    this.store.setSource(BOOK, { lastError: msg, state: this.ws?.readyState === WebSocket.OPEN ? 'live' : 'down' });
  }

  // ---------- 1) snapshot ----------
  snapshotUrl(league = this.leagues[0]) {
    const q = new URLSearchParams({ isBatchable: 'false', templateVars: league.dk, include: 'Events', entity: 'events',
      eventsQuery: `$filter=leagueId eq '${league.dk}' AND clientMetadata/Subcategories/any(s: s/Id eq '${SUBCATEGORY}')`,
      marketsQuery: `$filter=clientMetadata/subCategoryId eq '${SUBCATEGORY}' AND tags/all(t: t ne 'SportcastBetBuilder')` });
    return `${this.nashBase}/sites/${this.site}/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?${q}`;
  }

  /** Raw snapshot JSON from DK (used directly, and by the edge to relay). */
  fetchSnapshot(league = this.leagues[0]) { return this.http.getJson(this.snapshotUrl(league), this.headers(), 15_000); }

  /** Every league's snapshot, in parallel. The NFL one must succeed; another league failing only logs. */
  async snapshot() {
    const t0 = Date.now();
    const results = await Promise.allSettled(this.leagues.map(async (lg) => ({ lg, data: await this.fetchSnapshot(lg), at: Date.now() })));
    if (results[0].status === 'rejected') throw results[0].reason;
    let games = 0, prices = 0;
    for (const r of results) {
      if (r.status === 'rejected') { this.log('dk', `snapshot ${this.leagues[results.indexOf(r)].id} failed: ${r.reason?.message}`); continue; }
      const n = this.applySnapshot(r.value.data, r.value.at, 'direct', r.value.lg.id); games += n.games; prices += n.selections;
    }
    const now = Date.now();
    this.metrics.dk.snapshotMs.push(now - t0);
    this.store.setSource(BOOK, { lastError: null, transport: this.http.transport, snapshotMs: now - t0, detail: `${games} games, ${prices} prices (${this.leagues.map((l) => l.label).join(' + ')}), snapshot ${now - t0} ms (${this.http.transport} client)` });
  }

  /** Get a fresh snapshot the way this machine can: fetch it, or ask the edge for one. */
  refreshSnapshot(why) {
    if (this.stopped) return;
    if (!this.restBlocked) return this.snapshot().catch((e) => this.fail(`resnapshot (${why})`, e));
    if (this.onNeedSnapshot) this.onNeedSnapshot(why);
    // refused earlier: try ourselves again every 5 minutes, so the edge stays a fallback, never a dependency
    if (Date.now() - (this.lastDirectTry || 0) > 300_000) {
      this.lastDirectTry = Date.now();
      this.snapshot().then(() => { this.restBlocked = false; this.store.setSource(BOOK, { snapshotVia: 'direct' }); this.log('dk', 'snapshot host accepts us again → fetching snapshots directly'); }).catch(() => {});
    }
  }

  applySnapshot(data, now = Date.now(), via = 'direct', leagueId = 'nfl') {
    const games = new Map(); // dk eventId -> game
    for (const ev of data.events || []) {
      const g = this.gameFromEvent(ev, leagueId); if (!g) continue;
      games.set(ev.id, g); this.eventIndex.set(ev.id, g.key);
      this.store.upsertGame(g);
    }
    for (const m of data.markets || []) this.indexMarket(m, games.get(m.eventId)); // full objects: no flag = open
    const seen = new Set();
    for (const s of data.selections || []) { const ref = this.applySelection(s, now, null); if (ref) seen.add(`${ref.gameKey}|${ref.market}|${ref.side}`); }
    // A market that disappeared from the snapshot (suspended / taken down) must not keep showing a stale price.
    // Only this league's: each league has its own snapshot.
    if (games.size) for (const q of [...this.store.quotes.values()]) {
      if (q.book === BOOK && leagueOf(q.gameKey) === leagueId && !seen.has(`${q.gameKey}|${q.market}|${q.side}`)) this.store.removeQuotes(BOOK, q.gameKey, q.market);
    }
    this.metrics.dk.snapshots++;
    this.store.setSource(BOOK, { lastSnapshotAt: now, lastDataAt: now, snapshotVia: via });
    this.saveCheckpoint();
    return { games: games.size, selections: (data.selections || []).length };
  }

  gameFromEvent(ev, leagueId) {
    if (ev.eventParticipantType && ev.eventParticipantType !== 'TwoTeam') return null;
    const league = (ev.leagueId && DK_LEAGUE[String(ev.leagueId)]) || LEAGUES[leagueId] || LEAGUES.nfl;
    const home = league.resolve(ev.participants?.find((p) => p.venueRole === 'Home')?.name);
    const away = league.resolve(ev.participants?.find((p) => p.venueRole === 'Away')?.name);
    if (!home || !away || !ev.startEventDate) return null;
    const key = leagueGameKey(league.id, away, home, ev.startEventDate);
    return { key, league: league.id, home, away, start: ev.startEventDate, books: { [BOOK]: { eventId: ev.id, status: ev.status, live: LIVE_STATES.has(ev.status) } } };
  }

  /** Index one FULL market object (snapshot or `add`): a missing availability flag means open. */
  indexMarket(m, game) {
    const market = MARKET_MAP[m.name] || MARKET_MAP[m.marketType?.name];
    if (!market || !game) return null;
    const ref = { market, gameKey: game.key, game, suspended: closedFlag(m) ?? false }; this.marketIndex.set(m.id, ref); return ref;
  }

  /** Suspended = the market that feeds this quote is closed, or the selection itself is. */
  isSuspended(qid, marketId) {
    const qs = this.quoteSel.get(qid);
    const mk = this.marketIndex.get(marketId ?? qs?.marketId);
    return !!(mk?.suspended || qs?.closed);
  }

  /** A market opened or closed with no price change: re-apply availability to the quotes that market feeds. */
  applyAvailability(marketId, now, sourceTs) {
    const mk = this.marketIndex.get(marketId); if (!mk) return 0;
    let n = 0;
    for (const side of SIDES[mk.market] || []) {
      const qid = `${mk.gameKey}|${mk.market}|${side}|${BOOK}`;
      const cur = this.store.quotes.get(qid); if (!cur) continue;
      const fedBy = this.quoteSel.get(qid)?.marketId; if (fedBy && fedBy !== marketId) continue; // shown price comes from another DK market
      const q = { gameKey: cur.gameKey, market: cur.market, side: cur.side, book: BOOK, line: cur.line, odds: cur.odds, suspended: this.isSuspended(qid, marketId), sourceTs };
      if (this.store.upsertQuote(q, now)) { n++; this.metrics.dk.availabilityChanges = (this.metrics.dk.availabilityChanges || 0) + 1; if (sourceTs) this.recordLag(q, now - sourceTs); }
    }
    return n;
  }

  /** Index + upsert one full selection object (snapshot or `add`). Returns its ref or null. */
  applySelection(s, now, sourceTs) {
    const mk = this.marketIndex.get(s.marketId); if (!mk) return null;
    const game = mk.game || this.store.games.get(mk.gameKey); if (!game) return null;
    const side = this.sideOf(mk.market, s, game); if (!side) return null;
    const ref = { gameKey: mk.gameKey, market: mk.market, side, marketId: s.marketId };
    this.selIndex.set(s.id, ref);
    const fam = familyOf(s.id); if (fam) this.familyIndex.set(fam, ref);
    const qid = `${ref.gameKey}|${ref.market}|${ref.side}|${BOOK}`;
    this.quoteSel.set(qid, { marketId: s.marketId, closed: closedFlag(s) ?? false }); // a full selection: no flag = open
    const suspended = this.isSuspended(qid, s.marketId);
    const line = mk.market === 'moneyline' ? null : (s.points ?? lineFromId(s.id));
    let odds = parseAmerican(s.displayOdds?.american);
    if (odds == null && suspended) odds = this.store.quotes.get(qid)?.odds ?? null; // closed without a price: keep the last one, greyed
    const changed = this.store.upsertQuote({ gameKey: ref.gameKey, market: ref.market, side, book: BOOK, line, odds, suspended, sourceTs }, now);
    if (changed && sourceTs) this.recordLag(ref, now - sourceTs);
    return ref;
  }

  recordLag(ref, lag) { if (this.replaying) return; const g = this.store.games.get(ref.gameKey); (g?.status === 'live' ? this.metrics.dk.ingestLagLive : this.metrics.dk.ingestLagPregame).push(lag); this.metrics.dk.lastLagAt = Date.now(); }

  sideOf(market, sel, game) {
    if (market === 'total') return sel.outcomeType === 'Over' ? 'over' : sel.outcomeType === 'Under' ? 'under' : (/^over/i.test(sel.label) ? 'over' : /^under/i.test(sel.label) ? 'under' : null);
    if (sel.outcomeType === 'Home') return 'home';
    if (sel.outcomeType === 'Away') return 'away';
    const t = (LEAGUES[game.league || 'nfl'] || LEAGUES.nfl).resolve(sel.label);
    const k = (x) => x?.key ?? x?.abbr;
    return t ? (k(t) === k(game.home) ? 'home' : k(t) === k(game.away) ? 'away' : null) : null;
  }

  // ---------- 2) websocket deltas ----------
  wsUrl() { return this.wsUrlOverride || `wss://${this.wsHost}/websocket?format=json&locale=en`; }

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.wsUrl(), { headers: { origin: 'https://sportsbook.draftkings.com', 'user-agent': UA }, handshakeTimeout: 15_000, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      ws._socket?.setNoDelay(true);
      this.backoff = 1000;
      this.subSentAt = Date.now();
      for (const lg of this.leagues) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id: randomUUID(), params: {
        entity: 'events',
        queryParams: { query: `$filter=leagueId eq '${lg.dk}' AND clientMetadata/Subcategories/any(s: s/Id eq '${SUBCATEGORY}') and tags/any(t: t eq 'OSB')`,
          initialData: false, projection: 'sportsbook', locale: 'en',
          includeMarkets: `$filter=clientMetadata/subCategoryId eq '${SUBCATEGORY}' AND tags/all(t: t ne 'SportcastBetBuilder') and tags/any(t: t eq 'OSB')` },
        forwardedHeaders: {}, clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': '2643.4.1.10' },
        jwt: 'default-token', siteName: this.siteName } }));
      this.store.setSource(BOOK, { state: 'live', lastError: null, lastDataAt: Date.now() });
      this.log('dk', `socket open + subscribed (${this.wsHost}, ${this.siteName}, ${this.leagues.map((l) => l.label).join(' + ')})`);
      // Silence is normal on a delta feed (no line moved), so we ping to tell "quiet" from "dead".
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.ping(); clearTimeout(this.pongTimer);
        this.pongTimer = setTimeout(() => { this.log('dk', 'no pong → reconnect'); ws.terminate(); }, Math.min(10_000, this.pingMs));
      }, this.pingMs);
    });
    ws.on('pong', () => { clearTimeout(this.pongTimer); this.store.setSource(BOOK, { lastDataAt: Date.now() }); });
    ws.on('message', (buf) => this.onMessage(buf));
    ws.on('error', (e) => this.fail('websocket', e));
    ws.on('close', (code) => {
      clearInterval(this.pingTimer); clearTimeout(this.pongTimer);
      if (this.stopped || this.ws !== ws) return;
      this.metrics.dk.reconnects++;
      this.store.setSource(BOOK, { state: 'down', reconnects: this.metrics.dk.reconnects, detail: `socket closed (${code}); reconnecting in ${this.backoff / 1000}s` });
      this.reconnectTimer = setTimeout(() => { this.connect(); this.refreshSnapshot('reconnect'); }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  /** NTP-style: the ack carries DK's send time; offset = dkTime − midpoint(our send, our receive), error ≤ RTT/2. */
  syncClock(msg, now) {
    const dkTs = Date.parse(msg.websocketPublishTimestamp || '');
    if (!Number.isFinite(dkTs) || !this.subSentAt) return;
    const rttMs = now - this.subSentAt;
    const offsetMs = Math.round(dkTs - (this.subSentAt + now) / 2);
    if (Math.abs(offsetMs) > 10_000) return; // nonsense; keep raw timestamps
    if (!this.clock || rttMs <= this.clock.rttMs || now - this.clock.at > 30 * 60_000) {
      this.clock = { offsetMs, rttMs, at: now };
      this.metrics.dk.clockOffsetMs = offsetMs; this.metrics.dk.clockUncertaintyMs = Math.ceil(rttMs / 2);
      this.store.setSource(BOOK, { clockOffsetMs: offsetMs, clockUncertaintyMs: Math.ceil(rttMs / 2) });
    }
  }

  /** Apply one socket frame (JSON). Returns the number of prices that changed. */
  onMessage(buf, now = Date.now()) {
    this.metrics.dk.wsMessages++;
    const text = buf.toString();
    let msg; try { msg = JSON.parse(text); } catch { this.metrics.dk.decodeMisses++; return 0; }
    if (msg.event === 'subscribed') { this.syncClock(msg, now); return 0; }
    if (msg.event !== 'update') return 0;
    if (!this.replaying) {
      this.store.setSource(BOOK, { lastDataAt: now, updates: this.metrics.dk.wsMessages });
      if (this.checkpoint) { this.seq++; this.checkpoint.append(this.seq, text, now).catch(() => {}); }
    }
    const stamp = msg.data?.metadata?.publishedTime || msg.websocketPublishTimestamp;
    // DraftKings' publish time, converted to OUR clock with the offset measured on subscribe (± half the round trip)
    const sourceTs = stamp ? Date.parse(stamp) - (this.clock?.offsetMs ?? 0) : null;
    const d = msg.data?.data || {};
    let applied = 0, unknown = 0;
    const list = (x) => Array.isArray(x) ? x : [];
    // removals first: a line move is remove(old id) + add(new id)
    for (const s of list(d.remove?.selections)) this.selIndex.delete(typeof s === 'string' ? s : s?.id);
    for (const m of list(d.remove?.markets)) { const id = typeof m === 'string' ? m : m?.id; const mk = this.marketIndex.get(id); if (mk) { this.marketIndex.delete(id); this.store.removeQuotes(BOOK, mk.gameKey, mk.market); } }
    for (const e of list(d.add?.events)) { const g = this.gameFromEvent(e, 'nfl'); if (g) { this.eventIndex.set(e.id, g.key); this.store.upsertGame(g); } }
    for (const m of list(d.add?.markets)) {
      const key = this.eventIndex.get(m.eventId); const g = key && this.store.games.get(key);
      if (g && this.indexMarket(m, g)) applied += this.applyAvailability(m.id, now, sourceTs); // re-added market: its quotes follow its flag
    }
    // market-only changes: `isSuspended` true/false is the whole message (partial object; no flag = unchanged)
    for (const m of list(d.change?.markets)) {
      const mk = this.marketIndex.get(m?.id); const flag = closedFlag(m);
      if (!mk || flag === undefined || flag === mk.suspended) continue;
      mk.suspended = flag;
      applied += this.applyAvailability(m.id, now, sourceTs);
    }
    for (const s of list(d.add?.selections)) { if (this.applySelection(s, now, sourceTs)) applied++; else unknown++; }
    for (const s of list(d.change?.selections)) {
      let ref = this.selIndex.get(s.id);
      if (!ref) { const fam = familyOf(s.id); ref = fam && this.familyIndex.get(fam); if (ref) { this.selIndex.set(s.id, ref); this.metrics.dk.lineMovesMapped++; } }
      if (!ref) { unknown++; continue; }
      const qid = `${ref.gameKey}|${ref.market}|${ref.side}|${BOOK}`;
      const cur = this.store.quotes.get(qid);
      // partial: a field that is absent keeps its value (price, line, and the selection's own open/closed flag)
      const prevSel = this.quoteSel.get(qid); const flag = closedFlag(s);
      const marketId = ref.marketId ?? prevSel?.marketId;
      this.quoteSel.set(qid, { marketId, closed: flag ?? prevSel?.closed ?? false });
      const suspended = marketId ? this.isSuspended(qid, marketId) : (flag ?? cur?.suspended ?? false);
      const odds = s.displayOdds?.american != null ? parseAmerican(s.displayOdds.american) : cur?.odds ?? null;
      const line = ref.market === 'moneyline' ? null : (typeof s.points === 'number' ? s.points : (lineFromId(s.id) ?? cur?.line ?? null));
      if (this.store.upsertQuote({ gameKey: ref.gameKey, market: ref.market, side: ref.side, book: BOOK, line, odds, suspended, sourceTs }, now)) { applied++; if (sourceTs) this.recordLag(ref, now - sourceTs); }
    }
    for (const e of list(d.change?.events)) {
      const key = this.eventIndex.get(e.id); const g = key && this.store.games.get(key);
      if (g && typeof e.status === 'string') this.store.upsertGame({ key, books: { [BOOK]: { ...g.books[BOOK], status: e.status, live: LIVE_STATES.has(e.status) } } });
    }
    this.metrics.dk.selectionUpdates += applied;
    // Anything we could not place → ask for a fresh snapshot shortly (correctness check, never the fast path).
    if (unknown && !this.pendingResnap && !this.stopped) this.pendingResnap = setTimeout(() => { this.pendingResnap = null; this.refreshSnapshot('unknown ids'); }, 3000);
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
// 'CA-ON-SB' -> 'Ontario', 'US-NJ-SB' -> 'NJ'
export function regionLabel(site) { const r = site.replace(/-SB$/, '').split('-').pop(); return r === 'ON' ? 'Ontario' : r; }
// 'US-NJ-SB' -> 'dkusnj' / 'sportsbook-ws-us-nj.draftkings.com' (pattern observed on the Ontario site: CA-ON-SB -> dkcaon / sportsbook-ws-ca-on)
export function siteNameFor(site) { return 'dk' + site.replace(/-SB$/, '').replace(/-/g, '').toLowerCase(); }
export function wsHostFor(site) { return `sportsbook-ws-${site.replace(/-SB$/, '').toLowerCase()}.draftkings.com`; }
