// FanDuel worker.
//
// How the FD website gets odds (found with tools/capture-network.mjs, see research/):
//   1. ONE big snapshot:  GET api.sportsbook.fanduel.com/sbapi/content-managed-page?page=CUSTOM&customPageId=nfl&_ak=...
//      → attachments.events / attachments.markets (with runners = sides, handicap = line, americanOdds).  ~1.5 MB.
//   2. Then it POLLS:     POST smp.<region>.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices
//      body { marketIds: [...] } → fresh prices for those markets. The site does this about every 5 s per widget.
//      There is no WebSocket and no server-sent events on the page: FanDuel is a "full picture every time" feed,
//      so the freshest we can be is (poll interval + request time). We poll every FD_POLL_MS (default 2 s) with
//      ALL game-line markets in one request, and back off automatically if FanDuel answers 429/403.
import { resolveTeam, gameKey, parseAmerican } from '../model.js';

const BOOK = 'fanduel';
const APP_KEY = 'FhMFpcPWXMeyZxOx'; // public key embedded in the FanDuel web app
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MARKET_MAP = { MONEY_LINE: 'moneyline', 'MATCH_HANDICAP_(2-WAY)': 'spread', 'TOTAL_POINTS_(OVER/UNDER)': 'total' };

export class FanDuelSource {
  constructor(store, metrics, log, opts = {}) {
    this.store = store; this.metrics = metrics; this.log = log;
    this.region = (opts.region || process.env.FD_REGION || 'NJ').toUpperCase();
    this.basePollMs = Number(process.env.FD_POLL_MS || 2000);
    this.pollMs = this.basePollMs;
    this.resnapshotMs = Number(process.env.FD_RESNAPSHOT_MS || 60_000);
    this.marketIds = [];           // game-line markets we poll
    this.selIndex = new Map();     // `${marketId}:${selectionId}` -> { gameKey, market, side }
    this.marketIndex = new Map();  // marketId -> { gameKey, market }
    this.stopped = false; this.lastPollAt = null; this.inFlight = false;
  }

  headers() {
    return { accept: 'application/json', 'accept-language': 'en-CA', referer: 'https://sportsbook.fanduel.com/', origin: 'https://sportsbook.fanduel.com',
      'user-agent': UA, 'x-sportsbook-region': this.region, 'x-application': APP_KEY };
  }

  async start() {
    this.store.setSource(BOOK, { mode: 'poll', state: 'connecting', detail: `region ${this.region}, poll every ${this.pollMs} ms` });
    await this.snapshot().catch((e) => this.fail('snapshot', e));
    this.snapTimer = setInterval(() => this.snapshot().catch((e) => this.fail('resnapshot', e)), this.resnapshotMs);
    this.loop();
  }

  stop() { this.stopped = true; clearInterval(this.snapTimer); clearTimeout(this.pollTimer); }

  fail(where, e) {
    const msg = `${where}: ${e?.message || e}`;
    this.log('fd', msg);
    this.metrics.fd.pollErrors++;
    this.store.setSource(BOOK, { lastError: msg, state: 'down' });
  }

  // ---------- 1) snapshot ----------
  async snapshot() {
    const url = `https://api.sportsbook.fanduel.com/sbapi/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=${APP_KEY}&timezone=America%2FNew_York`;
    const t0 = Date.now();
    const r = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const data = await r.json();
    const now = Date.now();
    const n = this.applySnapshot(data, now);
    this.metrics.fd.snapshots++;
    this.store.setSource(BOOK, { lastSnapshotAt: now, lastDataAt: now, lastError: null, detail: `${n.games} games, ${n.markets} markets, snapshot ${now - t0} ms, poll every ${this.pollMs} ms` });
  }

  applySnapshot(data, now) {
    const events = data.attachments?.events || {};
    const all = Object.values(data.attachments?.markets || {}).filter((m) => MARKET_MAP[m.marketType]);
    // Build games from moneyline/spread runners (they name the teams); totals borrow the game from their event.
    const gameByEvent = new Map();
    for (const m of all) {
      if (MARKET_MAP[m.marketType] === 'total') continue;
      const homeR = m.runners?.find((r) => r.result?.type === 'HOME'), awayR = m.runners?.find((r) => r.result?.type === 'AWAY');
      const home = resolveTeam(homeR?.runnerName), away = resolveTeam(awayR?.runnerName);
      if (!home || !away) continue;
      const ev = events[m.eventId] || {};
      const start = ev.openDate || m.marketTime;
      const key = gameKey(away, home, start);
      const game = { key, home, away, start, books: { [BOOK]: { eventId: String(m.eventId), live: !!m.inPlay } } };
      gameByEvent.set(String(m.eventId), game);
    }
    const ids = [], seenMarkets = new Set(), seen = new Set();
    for (const m of all) {
      const game = gameByEvent.get(String(m.eventId)); if (!game) continue;
      const market = MARKET_MAP[m.marketType];
      if (m.inPlay) game.books[BOOK].live = true;
      this.marketIndex.set(m.marketId, { gameKey: game.key, market });
      ids.push(m.marketId); seenMarkets.add(m.marketId);
      for (const r of m.runners || []) {
        const side = this.sideOf(market, r, game); if (!side) continue;
        const ref = { gameKey: game.key, market, side };
        this.selIndex.set(`${m.marketId}:${r.selectionId}`, ref);
        seen.add(`${ref.gameKey}|${ref.market}|${ref.side}`);
        this.store.upsertQuote({ ...ref, book: BOOK, line: market === 'moneyline' ? null : r.handicap ?? null,
          odds: parseAmerican(r.winRunnerOdds?.americanDisplayOdds?.americanOdds), suspended: r.runnerStatus && r.runnerStatus !== 'ACTIVE', sourceTs: null }, now);
      }
    }
    for (const g of gameByEvent.values()) this.store.upsertGame(g);
    for (const q of [...this.store.quotes.values()]) {
      if (q.book === BOOK && !seen.has(`${q.gameKey}|${q.market}|${q.side}`) && gameByEvent.size) this.store.removeQuotes(BOOK, q.gameKey, q.market);
    }
    this.marketIds = ids;
    return { games: gameByEvent.size, markets: ids.length };
  }

  sideOf(market, runner, game) {
    const t = runner.result?.type;
    if (market === 'total') return t === 'OVER' ? 'over' : t === 'UNDER' ? 'under' : (/^over/i.test(runner.runnerName) ? 'over' : /^under/i.test(runner.runnerName) ? 'under' : null);
    if (t === 'HOME') return 'home'; if (t === 'AWAY') return 'away';
    const team = resolveTeam(runner.runnerName);
    return team ? (team.abbr === game.home.abbr ? 'home' : team.abbr === game.away.abbr ? 'away' : null) : null;
  }

  // ---------- 2) polling loop ----------
  loop() {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => { await this.poll(); this.loop(); }, this.pollMs);
  }

  async poll() {
    if (!this.marketIds.length || this.inFlight) return;
    this.inFlight = true;
    const t0 = Date.now();
    if (this.lastPollAt) this.metrics.fd.pollInterval.push(t0 - this.lastPollAt);
    this.lastPollAt = t0;
    try {
      const r = await fetch(`https://smp.${this.region.toLowerCase()}.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0`, {
        method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify({ marketIds: this.marketIds }), signal: AbortSignal.timeout(10_000) });
      this.metrics.fd.lastStatus = r.status;
      const text = await r.text();
      const now = Date.now();
      this.metrics.fd.pollDuration.push(now - t0); this.metrics.fd.bytes.push(text.length); this.metrics.fd.polls++;
      if (r.status !== 200) {
        // Rate-limited or blocked: slow down (2 s → 4 → 8 … max 30 s) instead of hammering.
        this.pollMs = Math.min(this.pollMs * 2, 30_000);
        throw new Error(`HTTP ${r.status} → polling every ${this.pollMs} ms`);
      }
      this.pollMs = Math.max(this.basePollMs, Math.round(this.pollMs * 0.7)); // recover gradually after an error
      let changes = 0;
      for (const m of JSON.parse(text)) {
        const mi = this.marketIndex.get(m.marketId); if (!mi) continue;
        const game = this.store.games.get(mi.gameKey);
        if (game && !!m.inplay !== !!game.books[BOOK]?.live) this.store.upsertGame({ key: mi.gameKey, books: { [BOOK]: { ...game.books[BOOK], live: !!m.inplay } } });
        for (const rd of m.runnerDetails || []) {
          const ref = this.selIndex.get(`${m.marketId}:${rd.selectionId}`); if (!ref) continue;
          if (this.store.upsertQuote({ ...ref, book: BOOK, line: mi.market === 'moneyline' ? null : rd.handicap ?? null,
            odds: parseAmerican(rd.winRunnerOdds?.americanDisplayOdds?.americanOdds), suspended: rd.runnerStatus && rd.runnerStatus !== 'ACTIVE', sourceTs: null }, now)) changes++;
        }
      }
      this.metrics.fd.changesPerPoll.push(changes);
      this.store.setSource(BOOK, { state: 'polling', lastDataAt: now, lastError: null, polls: this.metrics.fd.polls, detail: `${this.marketIds.length} markets/poll, ${now - t0} ms, every ${this.pollMs} ms` });
    } catch (e) {
      this.fail('poll', e);
    } finally { this.inFlight = false; }
  }
}
