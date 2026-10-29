// FanDuel "more lines": alt spreads/totals, anytime TD, yardage and reception milestones.
// FanDuel publishes these only on each game's own page, so:
//   discovery: one event-page request per game (every 10 min) → which markets/runners exist, with first prices
//   prices:    the same getMarketPrices POST as the main board, 50 markets per request, at most one request a second:
//              every 3 s for games someone has open on the board, every 60 s for the rest.
// It shares FanDuel's rate budget with the main board's poller, so on any 403/429 it pauses itself for 5 minutes
// (the main board's 1 s poll matters more than props).
import { fdKind, fdExtraRef, fdOdds, fdSuspended } from '../extras.js';
import { fanduelEndpoints } from './fanduel.js';

const BOOK = 'fanduel';
const APP_KEY = 'FhMFpcPWXMeyZxOx';

export class FanDuelExtras {
  constructor(extras, board, log, opts = {}) {
    this.extras = extras; this.board = board; this.log = log;
    this.region = (opts.region || process.env.FD_REGION || 'ON').toUpperCase();
    this.ep = fanduelEndpoints(this.region);
    this.headers = opts.headers;
    this.eventUrl = opts.eventUrl || process.env.FD_EVENT_URL || this.ep.snapshot.replace('content-managed-page', 'event-page');
    this.pricesUrl = opts.pricesUrl || process.env.FD_PRICES_URL || `${this.ep.prices}?priceHistory=0`;
    this.watched = opts.watched || (() => new Set());
    this.fastMs = Number(opts.fastMs || 3000); this.slowMs = Number(opts.slowMs || 60_000);
    this.discoverMs = Number(opts.discoverMs || 10 * 60_000); this.horizonMs = 8 * 86_400_000;
    this.markets = new Map();     // marketId -> { gameKey, kind }
    this.sel = new Map();         // `${marketId}:${selectionId}` -> { gameKey, r }
    this.polledAt = new Map();    // marketId -> last poll time
    this.pausedUntil = 0; this.inFlight = false; this.stopped = false;
    this.counts = { discovered: 0, polls: 0, errors: 0, changes: 0 };
  }

  async start() {
    await new Promise((r) => setTimeout(r, Number(process.env.FD_EXTRAS_DELAY_MS ?? 5000))); // let the main board load first
    await this.discover();
    this.discoverTimer = setInterval(() => this.discover(), this.discoverMs);
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }
  stop() { this.stopped = true; clearInterval(this.discoverTimer); clearInterval(this.tickTimer); }

  games(now = Date.now()) {
    return [...this.board.games.values()].filter((g) => g.books?.fanduel?.eventId && new Date(g.start).getTime() < now + this.horizonMs);
  }

  blocked(status, where) {
    if (status !== 403 && status !== 429) return false;
    this.pausedUntil = Date.now() + 5 * 60_000; this.counts.errors++;
    this.log('fd-extras', `${where}: HTTP ${status} → pausing extras for 5 min (main board unaffected)`);
    return true;
  }

  async discover() {
    const watched = this.watched();
    const order = this.games().sort((a, b) => (watched.has(b.key) ? 1 : 0) - (watched.has(a.key) ? 1 : 0));
    for (const g of order) {
      if (this.stopped || Date.now() < this.pausedUntil) return;
      await this.discoverGame(g).catch((e) => { this.counts.errors++; this.log('fd-extras', `event page ${g.key}: ${e.message}`); });
      await new Promise((r) => setTimeout(r, 700));
    }
    Object.assign(this.extras.status[BOOK], { lastSnapshotAt: Date.now(), detail: `${this.markets.size} markets on ${order.length} games` });
  }

  async discoverGame(g) {
    const id = g.books.fanduel.eventId;
    const url = `${this.eventUrl}?_ak=${APP_KEY}&eventId=${id}&tab=popular&timezone=${this.ep.tz}`;
    const r = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
    if (this.blocked(r.status, 'event page')) return;
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return this.applyEventPage(g.key, await r.json(), Date.now());
  }

  /** One game page: index every market we compare and take its prices. Offers the page no longer has are dropped. */
  applyEventPage(gameKey, page, now = Date.now()) {
    let n = 0;
    for (const m of Object.values(page?.attachments?.markets || {})) {
      const kind = fdKind(m.marketType); if (!kind) continue;
      this.markets.set(m.marketId, { gameKey, kind });
      for (const runner of m.runners || []) {
        const r = fdExtraRef(kind, m, runner); if (!r) continue;
        this.sel.set(`${m.marketId}:${runner.selectionId}`, { gameKey, r });
        const odds = fdOdds(runner); if (odds == null) continue;
        if (this.extras.upsert(BOOK, gameKey, { ...r, odds, suspended: fdSuspended(runner) || (m.marketStatus && m.marketStatus !== 'OPEN') }, now)) n++;
      }
      this.polledAt.set(m.marketId, now);
    }
    this.extras.sweep(BOOK, null, now, new Set([gameKey]));
    this.counts.discovered++; this.extras.status[BOOK].lastDataAt = now;
    return n;
  }

  /** Once a second: one price request for the markets that are due (open games every 3 s, the rest every 60 s). */
  async tick(now = Date.now()) {
    if (this.inFlight || this.stopped || now < this.pausedUntil || !this.markets.size) return;
    const watched = this.watched();
    const due = [...this.markets].filter(([id, m]) => now - (this.polledAt.get(id) || 0) >= (watched.has(m.gameKey) ? this.fastMs : this.slowMs))
      .sort((a, b) => (watched.has(b[1].gameKey) ? 1 : 0) - (watched.has(a[1].gameKey) ? 1 : 0) || (this.polledAt.get(a[0]) || 0) - (this.polledAt.get(b[0]) || 0))
      .slice(0, 50).map(([id]) => id);
    if (!due.length) return;
    this.inFlight = true;
    try {
      const r = await fetch(this.pricesUrl, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify({ marketIds: due }), signal: AbortSignal.timeout(5000) });
      if (this.blocked(r.status, 'prices')) return;
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const t = Date.now(); for (const id of due) this.polledAt.set(id, t);
      this.counts.polls++; this.counts.changes += this.applyPrices(await r.json(), t);
    } catch (e) { this.counts.errors++; if (this.counts.errors % 20 === 1) this.log('fd-extras', `prices: ${e.message}`); }
    finally { this.inFlight = false; }
  }

  applyPrices(list, now = Date.now()) {
    let n = 0;
    for (const m of list || []) {
      if (!this.markets.has(m.marketId)) continue;
      for (const rd of m.runnerDetails || []) {
        const s = this.sel.get(`${m.marketId}:${rd.selectionId}`); if (!s) continue;
        const odds = fdOdds(rd); if (odds == null) continue;
        if (this.extras.upsert(BOOK, s.gameKey, { ...s.r, odds, suspended: fdSuspended(rd) || (m.marketStatus && m.marketStatus !== 'OPEN') }, now)) n++;
      }
    }
    if (list?.length) this.extras.status[BOOK].lastDataAt = now;
    return n;
  }
}
