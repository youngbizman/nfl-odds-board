// FanDuel worker.
//
// How the FD website gets odds (found with tools/capture-network.mjs, see research/findings.md):
//   1. ONE big snapshot:  GET api.sportsbook.fanduel.com/sbapi/content-managed-page?page=CUSTOM&customPageId=nfl&_ak=...
//      → attachments.events / attachments.markets (with runners = sides, handicap = line, americanOdds).  ~1.5 MB.
//   2. It POLLS:          POST smp.<region>.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices
//      body { marketIds: [...] } → fresh prices for those markets. The site does this about every 5 s per widget.
//   3. And it SUBSCRIBES: AppSync GraphQL over WebSocket, onUpdateMarketPrice(ids) → one market's new prices the
//      moment FanDuel changes them (src/sources/fanduel-push.js).
//
// We use both: the push for speed, polling as the safety net (it fills whatever a reconnect missed). Polling asks for
// every game-line market on a fixed beat (start-to-start), split into parallel requests of at most 50 markets
// (FanDuel answers at most 80 markets per request and silently drops the rest), reuses the HTTP connection, and
// backs off automatically (×2, honouring Retry-After, max 30 s) if FanDuel answers 429/403/5xx.
import { parseAmerican } from '../model.js';
import { enabledLeagues, leagueGameKey, leagueOf, LEAGUES } from '../leagues.js';
import { FanDuelPush } from './fanduel-push.js';

const BOOK = 'fanduel';
const APP_KEY = 'FhMFpcPWXMeyZxOx'; // public key embedded in the FanDuel web app
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// A full page never overwrites a price the live price endpoint (poll or push) answered within this long: the page is a
// slower, possibly cached copy. NFL markets are polled every second and the rest every few seconds, so 30 s is generous;
// a market FanDuel stops answering for gets its price from the page again after that.
const SNAPSHOT_DEFER_MS = 30_000;
const MARKET_MAP = { MONEY_LINE: 'moneyline', 'MATCH_HANDICAP_(2-WAY)': 'spread', 'TOTAL_POINTS_(OVER/UNDER)': 'total' };
// FanDuel runs one site per jurisdiction. Ontario is a separate .ca site; US states share the .com API with a state code.
// Same API shape everywhere; only hosts, region code and referer change. Default ON = same jurisdiction as our DraftKings feed.
/** The region this process may use: always Ontario. Anything else in the configuration is refused, loudly. */
export function ontarioRegion(wanted, log) {
  if (wanted && String(wanted).toUpperCase() !== 'ON') log?.('fd', `FD_REGION=${wanted} ignored: this board shows Ontario prices only (ON)`);
  return 'ON';
}
export function fanduelEndpoints(region) {
  const r = region.toUpperCase();
  if (r === 'ON') return { label: 'Ontario', site: 'https://on.sportsbook.fanduel.ca/', tz: 'America%2FToronto',
    snapshot: 'https://sbapi.on.sportsbook.fanduel.ca/api/content-managed-page', prices: 'https://smp.on.sportsbook.fanduel.ca/api/sports/fixedodds/readonly/v1/getMarketPrices' };
  return { label: r, site: 'https://sportsbook.fanduel.com/', tz: 'America%2FNew_York',
    snapshot: 'https://api.sportsbook.fanduel.com/sbapi/content-managed-page', prices: `https://smp.${r.toLowerCase()}.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices` };
}

export class FanDuelSource {
  constructor(store, metrics, log, opts = {}) {
    this.store = store; this.metrics = metrics; this.log = log;
    this.region = ontarioRegion(opts.region || process.env.FD_REGION, log); // Ontario only, like DraftKings
    this.ep = fanduelEndpoints(this.region);
    this.basePollMs = Number(opts.pollMs || process.env.FD_POLL_MS || 1000);
    this.maxPollMs = 30_000;
    this.pollMs = this.basePollMs;
    this.resnapshotMs = Number(opts.resnapshotMs || process.env.FD_RESNAPSHOT_MS || 60_000);
    // One page per league (customPageId nfl / ncaaf / cfl). Tests point a single URL at a local fake FanDuel (NFL only).
    const single = opts.snapshotUrl || process.env.FD_SNAPSHOT_URL;
    this.leagues = single ? [LEAGUES.nfl] : (opts.leagues || enabledLeagues());
    const base = opts.snapshotBase || process.env.FD_SNAPSHOT_BASE; // tests: one fake serving every league's page
    this.snapshotUrls = Object.fromEntries(this.leagues.map((l) => [l.id, opts.snapshotUrls?.[l.id] || single || (base && `${base}${base.includes('?') ? '&' : '?'}customPageId=${l.fd}`) ||
      `${this.ep.snapshot}?page=CUSTOM&customPageId=${l.fd}&pbHorizontal=false&_ak=${APP_KEY}&timezone=${this.ep.tz}`]));
    this.snapshotUrl = this.snapshotUrls.nfl;
    this.pricesUrl = opts.pricesUrl || process.env.FD_PRICES_URL || `${this.ep.prices}?priceHistory=0`;
    this.chunkSize = Number(opts.chunkSize || process.env.FD_CHUNK || 50); // markets per request (FanDuel caps one answer at 80)
    this.pushEnabled = opts.push ?? process.env.FD_PUSH !== '0';
    // tests and local demos point the push at a fake AppSync (FD_PUSH_URL); normally the settings are read from FanDuel's app
    const fakePush = process.env.FD_PUSH_URL;
    this.pushOpts = opts.pushOpts || (fakePush ? { url: fakePush, getConfig: async () => ({ clientId: process.env.FD_PUSH_CLIENT_ID || 'local', endpoint: 'https://pir.on.sportsbook.fanduel.ca/graphql', wssUrl: fakePush }) } : {});
    this.push = null;
    this.marketIds = [];           // every game-line market (push subscribes to all of them)
    this.byLeague = new Map();     // league -> its market ids
    this.primaryIds = [];          // NFL: polled every beat
    this.otherIds = []; this.otherChunks = []; this.rot = 0; // other leagues: one chunk per beat, in turn; live games every beat
    this.liveExtraMax = Number(opts.liveExtraMax || process.env.FD_LIVE_EXTRA || 150); // at most this many live other-league markets per beat
    this.selIndex = new Map();     // `${marketId}:${selectionId}` -> { gameKey, market, side }
    this.marketIndex = new Map();  // marketId -> { gameKey, market }
    this.stopped = false; this.lastPollAt = null; this.inFlight = false;
    // Interleave: a second poller on another IP (the edge) polls half a beat after us. Each IP stays at 1 request/s,
    // the board gets a fresh FanDuel answer every 0.5 s. onMidBeat(marketIds) returns true if an edge was asked.
    this.onMidBeat = opts.onMidBeat || null;
    this.marketPolledAt = new Map(); // marketId -> start time of the newest poll applied (any poller), on our clock
    this.lastFreshAt = 0; this.edgeLastAt = 0;
  }

  headers() {
    return { accept: 'application/json', 'accept-language': 'en-CA', referer: this.ep.site, origin: this.ep.site.replace(/\/$/, ''),
      'user-agent': UA, 'x-sportsbook-region': this.region, 'x-application': APP_KEY };
  }

  async start() {
    this.store.setSource(BOOK, { mode: 'poll', state: 'connecting', region: this.ep.label, pollMs: this.pollMs, detail: `region ${this.region}, poll every ${this.pollMs} ms` });
    await this.snapshot().catch((e) => this.fail('snapshot', e));
    if (this.pushEnabled && !this.stopped) {
      this.push = new FanDuelPush({ region: this.region, log: this.log, onMarket: (m, now) => this.applyPush(m, now), onState: (st) => this.onPushState(st), ...this.pushOpts });
      this.push.setMarketIds(this.marketIds);
      this.push.start();
    }
    this.snapTimer = setInterval(() => this.snapshot().catch((e) => this.fail('resnapshot', e)), this.resnapshotMs);
    this.loop();
  }

  stop() { this.stopped = true; clearInterval(this.snapTimer); clearTimeout(this.pollTimer); clearTimeout(this.midTimer); this.push?.stop(); }

  // ---------- push (AppSync) ----------
  /** One pushed market. Its receive time is its "polled at": a poll that started earlier can no longer overwrite it. */
  applyPush(m, now = Date.now()) {
    this.metrics.fd.pushMarkets++;
    const lag = now - Date.parse(m.updatedAt || '');
    if (Number.isFinite(lag) && lag > -5_000 && lag < 120_000) { this.metrics.fd.pushLag.push(lag); this.metrics.fd.lastPushLagAt = now; } // FanDuel's stamp → our receipt
    const changes = this.applyPrices([m], now, now);
    this.metrics.fd.pushChanges += changes;
    if (!changes) this.metrics.fd.pushNoChange++; // the push confirmed what a poll had already shown (or carried no price change)
    const lg = leagueOf(this.marketIndex.get(m.marketId)?.gameKey); (this.metrics.fd.byLeague[lg] ||= { push: 0, poll: 0 }).push += changes;
    this.store.setSource(BOOK, { lastDataAt: now });
    return changes;
  }

  onPushState({ state, detail, subscribed }) {
    this.store.setSource(BOOK, { push: state, pushDetail: detail, pushMarkets: subscribed, mode: state === 'live' ? 'push+poll' : 'poll' });
    if (state === 'live') this.log('fd', `push live (${subscribed} markets); polling every ${this.pollMs} ms stays on as the safety net`);
  }

  fail(where, e) {
    const msg = `${where}: ${e?.message || e}`;
    this.log('fd', msg);
    this.metrics.fd.pollErrors++;
    // polling broke but the push is still delivering: not down, just without its safety net
    this.store.setSource(BOOK, { lastError: msg, state: this.push?.state === 'live' ? 'push' : 'down', pollMs: this.pollMs });
  }

  // ---------- 1) snapshot ----------
  async fetchPage(league) {
    const r = await fetch(this.snapshotUrls[league.id], { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    return r.json();
  }

  /** Every league's page, in parallel. The NFL page must succeed; another league failing only logs. */
  async snapshot() {
    const t0 = Date.now();
    const results = await Promise.allSettled(this.leagues.map((lg) => this.fetchPage(lg)));
    if (results[0].status === 'rejected') throw results[0].reason;
    const now = Date.now(); let games = 0, markets = 0;
    results.forEach((r, i) => {
      if (r.status === 'rejected') return this.log('fd', `snapshot ${this.leagues[i].id} failed: ${r.reason?.message}`);
      const n = this.applySnapshot(r.value, now, this.leagues[i].id, t0); games += n.games; markets += n.markets;
    });
    this.metrics.fd.snapshots++;
    this.store.setSource(BOOK, { lastSnapshotAt: now, lastDataAt: now, lastError: null, detail: `${games} games, ${markets} markets (${this.leagues.map((l) => l.label).join(' + ')}), snapshot ${now - t0} ms, poll every ${this.pollMs} ms` });
  }

  /**
   * One league's full page: which games and markets exist (discovery), and prices for any market the live price
   * endpoint has not answered for lately. requestedAt = when this page was asked for. The page is a slower, possibly
   * cached copy, so it never overwrites a price that the poll or the push delivered after it was requested, or in the
   * last SNAPSHOT_DEFER_MS (an older page arriving late can never roll a newer price back).
   */
  applySnapshot(data, now = Date.now(), leagueId = 'nfl', requestedAt = now) {
    const league = LEAGUES[leagueId] || LEAGUES.nfl;
    const events = data.attachments?.events || {};
    const all = Object.values(data.attachments?.markets || {}).filter((m) => MARKET_MAP[m.marketType]);
    // Build games from moneyline/spread runners (they name the teams); totals borrow the game from their event.
    const gameByEvent = new Map();
    for (const m of all) {
      if (MARKET_MAP[m.marketType] === 'total') continue;
      const homeR = m.runners?.find((r) => r.result?.type === 'HOME'), awayR = m.runners?.find((r) => r.result?.type === 'AWAY');
      const home = league.resolve(homeR?.runnerName), away = league.resolve(awayR?.runnerName);
      if (!home || !away) continue;
      const ev = events[m.eventId] || {};
      const start = ev.openDate || m.marketTime;
      const key = leagueGameKey(league.id, away, home, start);
      if (!gameByEvent.has(String(m.eventId))) gameByEvent.set(String(m.eventId), { key, league: league.id, home, away, start, books: { [BOOK]: { eventId: String(m.eventId), live: false } } });
    }
    const ids = [], seen = new Set();
    for (const m of all) {
      const game = gameByEvent.get(String(m.eventId)); if (!game) continue;
      const market = MARKET_MAP[m.marketType];
      if (m.inPlay) game.books[BOOK].live = true;
      this.marketIndex.set(m.marketId, { gameKey: game.key, market });
      ids.push(m.marketId);
      const answered = this.marketPolledAt.get(m.marketId);
      const newer = answered != null && (answered >= requestedAt || now - answered < SNAPSHOT_DEFER_MS); // the price endpoint is fresher
      const marketClosed = !!m.marketStatus && m.marketStatus !== 'OPEN'; // SUSPENDED / CLOSED: nothing in it can be bet
      for (const r of m.runners || []) {
        const side = this.sideOf(market, r, game); if (!side) continue;
        const ref = { gameKey: game.key, market, side };
        this.selIndex.set(`${m.marketId}:${r.selectionId}`, ref);
        seen.add(`${ref.gameKey}|${ref.market}|${ref.side}`);
        const id = `${ref.gameKey}|${ref.market}|${ref.side}|${BOOK}`;
        if (newer && this.store.quotes.has(id)) { this.metrics.fd.snapshotDeferred = (this.metrics.fd.snapshotDeferred || 0) + 1; continue; }
        const suspended = marketClosed || (!!r.runnerStatus && r.runnerStatus !== 'ACTIVE');
        let odds = parseAmerican(r.winRunnerOdds?.americanDisplayOdds?.americanOdds);
        if (odds == null && suspended) odds = this.store.quotes.get(id)?.odds ?? null; // greyed, last known price
        this.store.upsertQuote({ ...ref, book: BOOK, line: market === 'moneyline' ? null : r.handicap ?? null, odds, suspended, sourceTs: null }, now);
      }
    }
    for (const g of gameByEvent.values()) this.store.upsertGame(g);
    if (gameByEvent.size) for (const q of [...this.store.quotes.values()]) {
      if (q.book === BOOK && leagueOf(q.gameKey) === league.id && !seen.has(`${q.gameKey}|${q.market}|${q.side}`)) this.store.removeQuotes(BOOK, q.gameKey, q.market);
    }
    this.byLeague.set(league.id, ids);
    this.primaryIds = this.byLeague.get('nfl') || [];
    const others = [...this.byLeague].filter(([id]) => id !== 'nfl').flatMap(([, x]) => x);
    this.otherIds = others;
    this.otherChunks = others.length ? chunk(others, this.chunkSize) : [];
    this.marketIds = [...this.primaryIds, ...others];
    this.push?.setMarketIds(this.marketIds);
    return { games: gameByEvent.size, markets: ids.length };
  }

  sideOf(market, runner, game) {
    const t = runner.result?.type;
    if (market === 'total') return t === 'OVER' ? 'over' : t === 'UNDER' ? 'under' : (/^over/i.test(runner.runnerName) ? 'over' : /^under/i.test(runner.runnerName) ? 'under' : null);
    if (t === 'HOME') return 'home'; if (t === 'AWAY') return 'away';
    const team = (LEAGUES[game.league || 'nfl'] || LEAGUES.nfl).resolve(runner.runnerName);
    const k = (x) => x?.key ?? x?.abbr;
    return team ? (k(team) === k(game.home) ? 'home' : k(team) === k(game.away) ? 'away' : null) : null;
  }

  // ---------- 2) polling loop: fixed beat, start-to-start ----------
  loop(delay = this.pollMs) {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      const t0 = Date.now();
      if (this.onMidBeat && this.primaryIds.length) { clearTimeout(this.midTimer); this.midTimer = setTimeout(() => this.onMidBeat(this.primaryIds), this.pollMs / 2); }
      await this.poll();
      this.loop(Math.max(0, this.pollMs - (Date.now() - t0))); // a 16 ms request does not stretch a 1 s beat to 1.016 s
    }, delay);
  }

  /** A fresh answer arrived (from us or the edge): track how often the board gets one. */
  markFresh(now) { if (this.lastFreshAt) this.metrics.fd.freshInterval.push(now - this.lastFreshAt); this.lastFreshAt = now; }

  /**
   * Prices polled by the edge (another IP, half a beat after us). Only markets whose answer changed on the edge are sent.
   * polledAt = when the edge's request started, on our clock. A market is applied only if this poll is newer than the
   * newest poll already applied to it, so an answer that arrives late can never overwrite a fresher one.
   */
  applyEdgePrices(markets, polledAt, now = Date.now()) {
    this.metrics.fd.edgePolls++; this.edgeLastAt = now; this.markFresh(now);
    const changes = this.applyPrices(markets, now, polledAt);
    this.metrics.fd.edgeChanges += changes;
    this.store.setSource(BOOK, { interleave: true, lastDataAt: now });
    return changes;
  }

  /** Apply one getMarketPrices response. Returns the number of prices that changed. */
  applyPrices(list, now = Date.now(), polledAt = now, fromPoll = false) {
    let changes = 0;
    for (const m of list || []) {
      const mi = this.marketIndex.get(m.marketId); if (!mi) continue;
      const before = changes;
      if (polledAt < (this.marketPolledAt.get(m.marketId) ?? 0)) { this.metrics.fd.edgeStale++; continue; } // older than what we show
      this.marketPolledAt.set(m.marketId, polledAt);
      const game = this.store.games.get(mi.gameKey);
      if (game && !!m.inplay !== !!game.books[BOOK]?.live) this.store.upsertGame({ key: mi.gameKey, books: { [BOOK]: { ...game.books[BOOK], live: !!m.inplay } } });
      const marketClosed = !!m.marketStatus && m.marketStatus !== 'OPEN'; // SUSPENDED / CLOSED: nothing in it can be bet
      for (const rd of m.runnerDetails || []) {
        const ref = this.selIndex.get(`${m.marketId}:${rd.selectionId}`); if (!ref) continue;
        const suspended = marketClosed || (!!rd.runnerStatus && rd.runnerStatus !== 'ACTIVE');
        let odds = parseAmerican(rd.winRunnerOdds?.americanDisplayOdds?.americanOdds);
        if (odds == null && suspended) odds = this.store.quotes.get(`${ref.gameKey}|${ref.market}|${ref.side}|${BOOK}`)?.odds ?? null; // greyed, last known price
        if (this.store.upsertQuote({ ...ref, book: BOOK, line: mi.market === 'moneyline' ? null : rd.handicap ?? null, odds, suspended, sourceTs: null }, now)) changes++;
      }
      if (fromPoll && changes > before) (this.metrics.fd.byLeague[leagueOf(mi.gameKey)] ||= { push: 0, poll: 0 }).poll += changes - before;
    }
    return changes;
  }

  async poll() {
    if (!this.marketIds.length || this.inFlight) return;
    this.inFlight = true;
    const t0 = Date.now();
    if (this.lastPollAt) this.metrics.fd.pollInterval.push(t0 - this.lastPollAt);
    this.lastPollAt = t0;
    try {
      // All chunks at once; each is applied the moment it lands, so one slow chunk never holds back the others.
      // NFL every beat; the other leagues one chunk per beat, in turn
      // live college / CFL games are polled every beat too (in-play prices move every few seconds); the rest take turns
      const live = this.otherIds.filter((id) => this.store.games.get(this.marketIndex.get(id)?.gameKey)?.status === 'live').slice(0, this.liveExtraMax);
      const parts = [...(this.primaryIds.length ? chunk(this.primaryIds, this.chunkSize) : []), ...(live.length ? chunk(live, this.chunkSize) : []),
        ...(this.otherChunks.length ? [this.otherChunks[this.rot++ % this.otherChunks.length]] : [])];
      const requested = parts.reduce((a, p) => a + p.length, 0);
      const results = await Promise.all(parts.map((ids) => this.pollChunk(ids, t0)));
      const now = Date.now();
      this.metrics.fd.pollDuration.push(now - t0); this.metrics.fd.polls++;
      this.metrics.fd.bytes.push(results.reduce((a, r) => a + r.bytes, 0));
      const bad = results.find((r) => r.status !== 200);
      this.metrics.fd.lastStatus = bad ? bad.status : 200;
      if (bad) {
        // Rate-limited, blocked or broken: slow down instead of hammering. Honour Retry-After if FanDuel sends it.
        this.pollMs = Math.min(Math.max(this.pollMs * 2, bad.retryAfterMs || 0), this.maxPollMs);
        if (bad.status === 429 || bad.status === 403) this.metrics.fd.rateLimited++;
        throw new Error(`HTTP ${bad.status} → polling every ${this.pollMs} ms`);
      }
      this.pollMs = Math.max(this.basePollMs, Math.round(this.pollMs * 0.7)); // recover gradually after an error
      const changes = results.reduce((a, r) => a + r.changes, 0), returned = results.reduce((a, r) => a + r.returned, 0);
      this.metrics.fd.pollChanges += changes; this.lastLivePolled = live.length;
      this.metrics.fd.changesPerPoll.push(changes); this.markFresh(now);
      this.metrics.fd.marketsMissing = requested - returned; // FanDuel leaving markets out of an answer
      const interleave = now - this.edgeLastAt < 3 * this.pollMs;
      this.store.setSource(BOOK, { state: 'polling', lastDataAt: now, lastError: null, polls: this.metrics.fd.polls, pollMs: this.pollMs, lastPollMs: now - t0, interleave,
        detail: `${returned}/${requested} markets in ${parts.length} parallel request${parts.length > 1 ? 's' : ''}, ${now - t0} ms, every ${this.pollMs} ms${live.length ? ` (incl. ${live.length} live college/CFL markets)` : ''}${this.otherChunks.length ? ` (other leagues: 1 of ${this.otherChunks.length} chunks per beat)` : ''}${this.push?.state === 'live' ? ' + push on all ' + this.marketIds.length : ''}` });
    } catch (e) {
      this.fail('poll', e);
    } finally { this.inFlight = false; }
  }

  async pollChunk(ids, t0) {
    const r = await fetch(this.pricesUrl, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ marketIds: ids }), signal: AbortSignal.timeout(Math.max(3000, this.pollMs * 3)) });
    const text = await r.text();
    if (r.status !== 200) return { status: r.status, bytes: text.length, retryAfterMs: Number(r.headers.get('retry-after')) * 1000 || 0, changes: 0, returned: 0 };
    const list = JSON.parse(text);
    const changes = this.applyPrices(list, Date.now(), t0, true);
    return { status: 200, bytes: text.length, changes, returned: Array.isArray(list) ? list.length : 0 };
  }
}

/** Split into the fewest requests of at most `size`, evenly (87 → 44 + 43, not 50 + 37). */
export function chunk(list, size) {
  const n = Math.max(1, Math.ceil(list.length / size)), per = Math.ceil(list.length / n), out = [];
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per));
  return out;
}
