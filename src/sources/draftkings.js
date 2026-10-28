// DraftKings worker.
//
// How the DK website gets odds (found with tools/capture-network.mjs, see research/findings.md):
//   1. ONE snapshot over HTTPS:   GET sportsbook-nash.draftkings.com/sites/<SITE>/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?...
//      → { events[], markets[], selections[] } for the league (88808 = NFL) and subcategory 4518 (= "Game Lines").
//   2. Then a WebSocket:  wss://sportsbook-ws-<region>.draftkings.com/websocket?format=json
//      JSON-RPC "subscribe" with the same filters, initialData:false → the server pushes only CHANGES:
//      { add, change, remove } × { events, markets, selections }, each frame stamped with DK's own publishedTime.
//
// Two different Akamai products sit in front of those hosts. The snapshot host refuses datacenter IPs (403);
// the socket host accepts them, for every region. So on a cloud server this worker holds the socket itself and
// takes its snapshots from an edge machine DK accepts (src/edge.js → /ingest/dk-snapshot). On a residential IP it
// does both itself. The socket is not geo-fenced: the region only selects which site's prices you subscribe to.
//
// Line moves: DK encodes the line in the selection id ("0HC84695615P350_3" = spread +3.5, away). A move arrives as
// remove(old id) + add(new id, with marketId and points) and is applied immediately. If a change names an id we
// cannot place, we ask for a fresh snapshot (3 s debounce) as a correctness check, never as the fast path.
import WebSocket from 'ws';
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
    // The site we subscribe to (DK_SITE, default Ontario = same jurisdiction as our FanDuel feed). Other regional
    // sites are tried for the REST snapshot only if the preferred one refuses this machine.
    const pref = opts.site || process.env.DK_SITE || 'CA-ON-SB';
    this.candidates = opts.candidates || [pref, ...SITES].filter((s, i, a) => a.indexOf(s) === i).map((site) => ({ site, siteName: siteNameFor(site), wsHost: wsHostFor(site) }));
    Object.assign(this, this.candidates[0]);
    this.nashBase = opts.nashBase || process.env.DK_NASH_BASE || 'https://sportsbook-nash.draftkings.com';
    this.wsUrlOverride = opts.wsUrl || process.env.DK_WS_URL || null;
    this.resnapshotMs = Number(opts.resnapshotMs || process.env.DK_RESNAPSHOT_MS || 60_000);
    this.pingMs = Number(opts.pingMs || 30_000);
    this.selIndex = new Map();    // DK selection id -> { gameKey, market, side }
    this.familyIndex = new Map(); // "HC84695615_3" -> { gameKey, market, side } (survives line moves)
    this.marketIndex = new Map(); // DK market id -> { gameKey, market }
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
    const ok = await this.pickSite();   // loads the first snapshot when this IP is allowed
    if (this.stopped) return;
    if (!ok) {
      this.restBlocked = true;
      Object.assign(this, this.candidates[0]); // subscribe to the preferred site anyway: the socket is open to everyone
      const restored = this.store.sources[BOOK]?.snapshotVia === 'checkpoint';
      this.store.setSource(BOOK, { mode: 'websocket', region: regionLabel(this.site), ...(restored ? {} : { snapshotVia: 'edge' }), detail: `snapshot host refuses this IP; socket direct, ${restored ? 'board restored from checkpoint, ' : ''}snapshots from edge` });
      this.log('dk', `snapshot host refuses this IP → socket direct (${this.wsHost}), waiting for a snapshot from the edge`);
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
      selIndex: [...this.selIndex], familyIndex: [...this.familyIndex], eventIndex: [...this.eventIndex],
      marketIndex: [...this.marketIndex].map(([id, r]) => [id, { market: r.market, gameKey: r.gameKey }]) };
  }

  importState(st) {
    for (const g of st.games || []) this.store.upsertGame(g);
    for (const q of st.quotes || []) this.store.upsertQuote(q, q.updatedAt || st.savedAt);
    this.selIndex = new Map(st.selIndex); this.familyIndex = new Map(st.familyIndex); this.eventIndex = new Map(st.eventIndex);
    this.marketIndex = new Map(st.marketIndex);
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

  /** Try each regional site until one gives us a snapshot (the snapshot host is fenced by IP, see README). */
  async pickSite() {
    for (const c of this.candidates) {
      Object.assign(this, c);
      try { await this.snapshot(); this.log('dk', `snapshot ok from ${c.site} (${c.siteName}, ${c.wsHost})`); return true; }
      catch (e) { this.log('dk', `site ${c.site} rejected: ${String(e.message).split('\n')[0].slice(0, 60)}`); }
      if (this.stopped) return false;
    }
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

  /** Raw snapshot JSON from DK (used directly, and by the edge to relay). */
  async fetchSnapshot() {
    const r = await fetch(this.snapshotUrl(), { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    return r.json();
  }

  async snapshot() {
    const t0 = Date.now();
    const data = await this.fetchSnapshot();
    const now = Date.now();
    this.applySnapshot(data, now, 'direct');
    this.store.setSource(BOOK, { lastError: null, detail: `${data.events?.length ?? 0} games, ${data.selections?.length ?? 0} prices, snapshot ${now - t0} ms` });
  }

  /** Get a fresh snapshot the way this machine can: fetch it, or ask the edge for one. */
  refreshSnapshot(why) {
    if (this.stopped) return;
    if (!this.restBlocked) return this.snapshot().catch((e) => this.fail(`resnapshot (${why})`, e));
    if (this.onNeedSnapshot) this.onNeedSnapshot(why);
  }

  applySnapshot(data, now = Date.now(), via = 'direct') {
    const games = new Map(); // dk eventId -> game
    for (const ev of data.events || []) {
      const g = this.gameFromEvent(ev); if (!g) continue;
      games.set(ev.id, g); this.eventIndex.set(ev.id, g.key);
      this.store.upsertGame(g);
    }
    for (const m of data.markets || []) this.indexMarket(m, games.get(m.eventId));
    const seen = new Set();
    for (const s of data.selections || []) { const ref = this.applySelection(s, now, null); if (ref) seen.add(`${ref.gameKey}|${ref.market}|${ref.side}`); }
    // A market that disappeared from the snapshot (suspended / taken down) must not keep showing a stale price.
    if (games.size) for (const q of [...this.store.quotes.values()]) {
      if (q.book === BOOK && !seen.has(`${q.gameKey}|${q.market}|${q.side}`)) this.store.removeQuotes(BOOK, q.gameKey, q.market);
    }
    this.metrics.dk.snapshots++;
    this.store.setSource(BOOK, { lastSnapshotAt: now, lastDataAt: now, snapshotVia: via });
    this.saveCheckpoint();
    return { games: games.size, selections: (data.selections || []).length };
  }

  gameFromEvent(ev) {
    if (ev.eventParticipantType && ev.eventParticipantType !== 'TwoTeam') return null;
    const home = resolveTeam(ev.participants?.find((p) => p.venueRole === 'Home')?.name);
    const away = resolveTeam(ev.participants?.find((p) => p.venueRole === 'Away')?.name);
    if (!home || !away || !ev.startEventDate) return null;
    const key = gameKey(away, home, ev.startEventDate);
    return { key, home, away, start: ev.startEventDate, books: { [BOOK]: { eventId: ev.id, status: ev.status, live: LIVE_STATES.has(ev.status) } } };
  }

  indexMarket(m, game) {
    const market = MARKET_MAP[m.name] || MARKET_MAP[m.marketType?.name];
    if (!market || !game) return null;
    const ref = { market, gameKey: game.key, game }; this.marketIndex.set(m.id, ref); return ref;
  }

  /** Index + upsert one full selection object (snapshot or `add`). Returns its ref or null. */
  applySelection(s, now, sourceTs) {
    const mk = this.marketIndex.get(s.marketId); if (!mk) return null;
    const game = mk.game || this.store.games.get(mk.gameKey); if (!game) return null;
    const side = this.sideOf(mk.market, s, game); if (!side) return null;
    const ref = { gameKey: mk.gameKey, market: mk.market, side };
    this.selIndex.set(s.id, ref);
    const fam = familyOf(s.id); if (fam) this.familyIndex.set(fam, ref);
    const line = mk.market === 'moneyline' ? null : (s.points ?? lineFromId(s.id));
    const changed = this.store.upsertQuote({ ...ref, book: BOOK, line, odds: parseAmerican(s.displayOdds?.american), sourceTs }, now);
    if (changed && sourceTs) this.recordLag(ref, now - sourceTs);
    return ref;
  }

  recordLag(ref, lag) { if (this.replaying) return; const g = this.store.games.get(ref.gameKey); (g?.status === 'live' ? this.metrics.dk.ingestLagLive : this.metrics.dk.ingestLagPregame).push(lag); }

  sideOf(market, sel, game) {
    if (market === 'total') return sel.outcomeType === 'Over' ? 'over' : sel.outcomeType === 'Under' ? 'under' : (/^over/i.test(sel.label) ? 'over' : /^under/i.test(sel.label) ? 'under' : null);
    if (sel.outcomeType === 'Home') return 'home';
    if (sel.outcomeType === 'Away') return 'away';
    const t = resolveTeam(sel.label);
    return t ? (t.abbr === game.home.abbr ? 'home' : t.abbr === game.away.abbr ? 'away' : null) : null;
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
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id: randomUUID(), params: {
        entity: 'events',
        queryParams: { query: `$filter=leagueId eq '${LEAGUE}' AND clientMetadata/Subcategories/any(s: s/Id eq '${SUBCATEGORY}') and tags/any(t: t eq 'OSB')`,
          initialData: false, projection: 'sportsbook', locale: 'en',
          includeMarkets: `$filter=clientMetadata/subCategoryId eq '${SUBCATEGORY}' AND tags/all(t: t ne 'SportcastBetBuilder') and tags/any(t: t eq 'OSB')` },
        forwardedHeaders: {}, clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': '2643.4.1.10' },
        jwt: 'default-token', siteName: this.siteName } }));
      this.store.setSource(BOOK, { state: 'live', lastError: null, lastDataAt: Date.now() });
      this.log('dk', `socket open + subscribed (${this.wsHost}, ${this.siteName})`);
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
    for (const e of list(d.add?.events)) { const g = this.gameFromEvent(e); if (g) { this.eventIndex.set(e.id, g.key); this.store.upsertGame(g); } }
    for (const m of list(d.add?.markets)) { const key = this.eventIndex.get(m.eventId); const g = key && this.store.games.get(key); if (g) this.indexMarket(m, g); }
    for (const s of list(d.add?.selections)) { if (this.applySelection(s, now, sourceTs)) applied++; else unknown++; }
    for (const s of list(d.change?.selections)) {
      let ref = this.selIndex.get(s.id);
      if (!ref) { const fam = familyOf(s.id); ref = fam && this.familyIndex.get(fam); if (ref) { this.selIndex.set(s.id, ref); this.metrics.dk.lineMovesMapped++; } }
      if (!ref) { unknown++; continue; }
      const cur = this.store.quotes.get(`${ref.gameKey}|${ref.market}|${ref.side}|${BOOK}`);
      const odds = s.displayOdds?.american != null ? parseAmerican(s.displayOdds.american) : cur?.odds ?? null;
      const line = ref.market === 'moneyline' ? null : (typeof s.points === 'number' ? s.points : (lineFromId(s.id) ?? cur?.line ?? null));
      if (this.store.upsertQuote({ ...ref, book: BOOK, line, odds, sourceTs }, now)) { applied++; if (sourceTs) this.recordLag(ref, now - sourceTs); }
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
