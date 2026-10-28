// FanDuel worker.
//
// How the FD website gets odds (found with tools/capture-network.mjs, see research/findings.md):
//   1. ONE big snapshot:  GET api.sportsbook.fanduel.com/sbapi/content-managed-page?page=CUSTOM&customPageId=nfl&_ak=...
//      → attachments.events / attachments.markets (with runners = sides, handicap = line, americanOdds).  ~1.5 MB.
//   2. Then it POLLS:     POST smp.<region>.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices
//      body { marketIds: [...] } → fresh prices for those markets. The site does this about every 5 s per widget.
//      There is no WebSocket and no server-sent events on the page: FanDuel is a "full picture every time" feed,
//      so the freshest we can be is (poll interval + request time).
//
// We poll ALL game-line markets in ONE request on a fixed beat (start-to-start, default 1 s), reuse the HTTP
// connection, and back off automatically (×2, honouring Retry-After, max 30 s) if FanDuel answers 429/403/5xx.
import { resolveTeam, gameKey, parseAmerican } from '../model.js';

const BOOK = 'fanduel';
const APP_KEY = 'FhMFpcPWXMeyZxOx'; // public key embedded in the FanDuel web app
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MARKET_MAP = { MONEY_LINE: 'moneyline', 'MATCH_HANDICAP_(2-WAY)': 'spread', 'TOTAL_POINTS_(OVER/UNDER)': 'total' };
// FanDuel runs one site per jurisdiction. Ontario is a separate .ca site; US states share the .com API with a state code.
// Same API shape everywhere; only hosts, region code and referer change. Default ON = same jurisdiction as our DraftKings feed.
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
    this.region = (opts.region || process.env.FD_REGION || 'ON').toUpperCase();
    this.ep = fanduelEndpoints(this.region);
    this.basePollMs = Number(opts.pollMs || process.env.FD_POLL_MS || 1000);
    this.maxPollMs = 30_000;
    this.pollMs = this.basePollMs;
    this.resnapshotMs = Number(opts.resnapshotMs || process.env.FD_RESNAPSHOT_MS || 60_000);
    // Overridable endpoints (tests point these at a local fake FanDuel).
    this.snapshotUrl = opts.snapshotUrl || process.env.FD_SNAPSHOT_URL ||
      `${this.ep.snapshot}?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=${APP_KEY}&timezone=${this.ep.tz}`;
    this.pricesUrl = opts.pricesUrl || process.env.FD_PRICES_URL || `${this.ep.prices}?priceHistory=0`;
    this.marketIds = [];           // game-line markets we poll
    this.selIndex = new Map();     // `${marketId}:${selectionId}` -> { gameKey, market, side }
    this.marketIndex = new Map();  // marketId -> { gameKey, market }
    this.stopped = false; this.lastPollAt = null; this.inFlight = false;
  }

  headers() {
    return { accept: 'application/json', 'accept-language': 'en-CA', referer: this.ep.site, origin: this.ep.site.replace(/\/$/, ''),
      'user-agent': UA, 'x-sportsbook-region': this.region, 'x-application': APP_KEY };
  }

  async start() {
    this.store.setSource(BOOK, { mode: 'poll', state: 'connecting', region: this.ep.label, pollMs: this.pollMs, detail: `region ${this.region}, poll every ${this.pollMs} ms` });
    await this.snapshot().catch((e) => this.fail('snapshot', e));
    this.snapTimer = setInterval(() => this.snapshot().catch((e) => this.fail('resnapshot', e)), this.resnapshotMs);
    this.loop();
  }

  stop() { this.stopped = true; clearInterval(this.snapTimer); clearTimeout(this.pollTimer); }

  fail(where, e) {
    const msg = `${where}: ${e?.message || e}`;
    this.log('fd', msg);
    this.metrics.fd.pollErrors++;
    this.store.setSource(BOOK, { lastError: msg, state: 'down', pollMs: this.pollMs });
  }

  // ---------- 1) snapshot ----------
  async snapshot() {
    const t0 = Date.now();
    const r = await fetch(this.snapshotUrl, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const data = await r.json();
    const now = Date.now();
    const n = this.applySnapshot(data, now);
    this.metrics.fd.snapshots++;
    this.store.setSource(BOOK, { lastSnapshotAt: now, lastDataAt: now, lastError: null, detail: `${n.games} games, ${n.markets} markets, snapshot ${now - t0} ms, poll every ${this.pollMs} ms` });
  }

  applySnapshot(data, now = Date.now()) {
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
      if (!gameByEvent.has(String(m.eventId))) gameByEvent.set(String(m.eventId), { key, home, away, start, books: { [BOOK]: { eventId: String(m.eventId), live: false } } });
    }
    const ids = [], seen = new Set();
    for (const m of all) {
      const game = gameByEvent.get(String(m.eventId)); if (!game) continue;
      const market = MARKET_MAP[m.marketType];
      if (m.inPlay) game.books[BOOK].live = true;
      this.marketIndex.set(m.marketId, { gameKey: game.key, market });
      ids.push(m.marketId);
      for (const r of m.runners || []) {
        const side = this.sideOf(market, r, game); if (!side) continue;
        const ref = { gameKey: game.key, market, side };
        this.selIndex.set(`${m.marketId}:${r.selectionId}`, ref);
        seen.add(`${ref.gameKey}|${ref.market}|${ref.side}`);
        this.store.upsertQuote({ ...ref, book: BOOK, line: market === 'moneyline' ? null : r.handicap ?? null,
          odds: parseAmerican(r.winRunnerOdds?.americanDisplayOdds?.americanOdds), suspended: !!r.runnerStatus && r.runnerStatus !== 'ACTIVE', sourceTs: null }, now);
      }
    }
    for (const g of gameByEvent.values()) this.store.upsertGame(g);
    if (gameByEvent.size) for (const q of [...this.store.quotes.values()]) {
      if (q.book === BOOK && !seen.has(`${q.gameKey}|${q.market}|${q.side}`)) this.store.removeQuotes(BOOK, q.gameKey, q.market);
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

  // ---------- 2) polling loop: fixed beat, start-to-start ----------
  loop(delay = this.pollMs) {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      const t0 = Date.now();
      await this.poll();
      this.loop(Math.max(0, this.pollMs - (Date.now() - t0))); // a 16 ms request does not stretch a 1 s beat to 1.016 s
    }, delay);
  }

  /** Apply one getMarketPrices response. Returns the number of prices that changed. */
  applyPrices(list, now = Date.now()) {
    let changes = 0;
    for (const m of list || []) {
      const mi = this.marketIndex.get(m.marketId); if (!mi) continue;
      const game = this.store.games.get(mi.gameKey);
      if (game && !!m.inplay !== !!game.books[BOOK]?.live) this.store.upsertGame({ key: mi.gameKey, books: { [BOOK]: { ...game.books[BOOK], live: !!m.inplay } } });
      for (const rd of m.runnerDetails || []) {
        const ref = this.selIndex.get(`${m.marketId}:${rd.selectionId}`); if (!ref) continue;
        if (this.store.upsertQuote({ ...ref, book: BOOK, line: mi.market === 'moneyline' ? null : rd.handicap ?? null,
          odds: parseAmerican(rd.winRunnerOdds?.americanDisplayOdds?.americanOdds), suspended: !!rd.runnerStatus && rd.runnerStatus !== 'ACTIVE', sourceTs: null }, now)) changes++;
      }
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
      const r = await fetch(this.pricesUrl, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ marketIds: this.marketIds }), signal: AbortSignal.timeout(Math.max(3000, this.pollMs * 3)) });
      this.metrics.fd.lastStatus = r.status;
      const text = await r.text();
      const now = Date.now();
      this.metrics.fd.pollDuration.push(now - t0); this.metrics.fd.bytes.push(text.length); this.metrics.fd.polls++;
      if (r.status !== 200) {
        // Rate-limited, blocked or broken: slow down instead of hammering. Honour Retry-After if FanDuel sends it.
        const retryAfter = Number(r.headers.get('retry-after')) * 1000;
        this.pollMs = Math.min(Math.max(this.pollMs * 2, retryAfter || 0), this.maxPollMs);
        if (r.status === 429 || r.status === 403) this.metrics.fd.rateLimited++;
        throw new Error(`HTTP ${r.status} → polling every ${this.pollMs} ms`);
      }
      this.pollMs = Math.max(this.basePollMs, Math.round(this.pollMs * 0.7)); // recover gradually after an error
      const changes = this.applyPrices(JSON.parse(text), now);
      this.metrics.fd.changesPerPoll.push(changes);
      this.store.setSource(BOOK, { state: 'polling', lastDataAt: now, lastError: null, polls: this.metrics.fd.polls, pollMs: this.pollMs, lastPollMs: now - t0,
        detail: `${this.marketIds.length} markets/poll, ${now - t0} ms, every ${this.pollMs} ms` });
    } catch (e) {
      this.fail('poll', e);
    } finally { this.inFlight = false; }
  }
}
