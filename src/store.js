// In-memory board: the single place both book workers write into and all browsers read from.
// One process holds one copy; browsers get a snapshot on connect and deltas afterwards.
import { EventEmitter } from 'node:events';
import { BOOKS } from './model.js';

const HISTORY_KEEP_MS = 8 * 24 * 3600_000; // price history kept per quote (movement charts go back up to a week)
const HISTORY_MAX = 5000;                   // and at most this many points per quote

export class BoardStore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.games = new Map();   // gameKey -> Game
    this.quotes = new Map();  // `${gameKey}|${market}|${side}|${book}` -> Quote
    this.history = new Map(); // quote id -> [[t, odds, line], ...]: one point per real change (movement charts)
    this.sources = Object.fromEntries(BOOKS.map((b) => [b, {
      book: b, mode: null, state: 'starting', lastDataAt: null, lastSnapshotAt: null, lastChangeAt: null,
      lastError: null, reconnects: 0, updates: 0, polls: 0, stale: true, detail: '',
    }]));
  }

  static quoteId(q) { return `${q.gameKey}|${q.market}|${q.side}|${q.book}`; }

  /** Insert/merge a game. Returns true if something visible changed. */
  upsertGame(g) {
    const prev = this.games.get(g.key);
    const next = prev ? { ...prev, ...g, books: { ...prev.books, ...g.books } } : { ...g, books: { ...g.books } };
    // status: live if any book says live, otherwise pregame; never downgrade live -> pregame from a book that lacks the flag
    const anyLive = Object.values(next.books).some((b) => b?.live);
    next.status = anyLive ? 'live' : (next.status || 'pregame');
    const changed = !prev || JSON.stringify(prev) !== JSON.stringify(next);
    if (changed) { this.games.set(g.key, next); this.emit('game', next); }
    return changed;
  }

  /**
   * Insert/replace a quote. Only emits when price, line or availability actually changed, so idle polls cost nothing downstream.
   * q = { gameKey, market, side, book, line, odds, sourceTs? }
   */
  upsertQuote(q, now = Date.now()) {
    const id = BoardStore.quoteId(q);
    const prev = this.quotes.get(id);
    if (prev && prev.odds === q.odds && prev.line === q.line && prev.suspended === !!q.suspended) return false;
    const next = {
      ...q, id, suspended: !!q.suspended, updatedAt: now,
      prevOdds: prev ? prev.odds : null, prevLine: prev ? prev.line : null,
    };
    this.quotes.set(id, next);
    this.record(id, now, next.odds, next.line);
    const src = this.sources[q.book]; if (src) { src.lastChangeAt = now; }
    this.emit('quote', next);
    return true;
  }

  /** Drop every quote of one book for a game/market (used when a book removes or re-keys a market). */
  removeQuotes(book, gameKey, market) {
    for (const [id, q] of this.quotes) {
      if (q.book === book && q.gameKey === gameKey && (!market || q.market === market)) { this.quotes.delete(id); this.emit('quote', { ...q, removed: true, updatedAt: Date.now() }); }
    }
  }

  /** Update a book's status. Emits only when something a viewer cares about changed (state, stale, mode, error, snapshot);
   *  counters like lastDataAt change on every poll and are delivered by the periodic status heartbeat instead. */
  setSource(book, patch) {
    const s = this.sources[book]; if (!s) return;
    const before = JSON.stringify([s.state, s.stale, s.mode, s.region, s.interleave, s.push, s.transport, s.lastError, s.lastSnapshotAt, s.reconnects]);
    Object.assign(s, patch);
    const after = JSON.stringify([s.state, s.stale, s.mode, s.region, s.interleave, s.push, s.transport, s.lastError, s.lastSnapshotAt, s.reconnects]);
    if (before !== after) this.emit('source', { ...s });
  }

  /** Mark data as stale when a book has gone quiet for longer than its own threshold. Called on a timer. */
  refreshStaleness(thresholds, now = Date.now()) {
    for (const b of BOOKS) {
      const s = this.sources[b];
      const stale = s.state === 'down' || !s.lastDataAt || now - s.lastDataAt > thresholds[b];
      if (stale !== s.stale) { s.stale = stale; this.emit('source', { ...s }); }
    }
  }

  /** Append one history point, only if the price or line differs from the last one recorded. */
  record(id, t, odds, line) {
    if (odds == null) return;
    let h = this.history.get(id); if (!h) this.history.set(id, (h = []));
    const last = h[h.length - 1];
    if (last && last[1] === odds && last[2] === (line ?? null)) return;
    h.push([t, odds, line ?? null]);
    if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
  }

  /** History to persist (trimmed to the keep window). */
  exportHistory(now = Date.now()) {
    const out = {};
    for (const [id, h] of this.history) {
      // keep the last point before the window too: it is the price at the window's start
      let i = h.findIndex((p) => p[0] >= now - HISTORY_KEEP_MS); if (i === -1) i = h.length - 1; else if (i > 0) i--;
      out[id] = h.slice(i);
    }
    return out;
  }
  importHistory(obj) { for (const [id, h] of Object.entries(obj || {})) if (Array.isArray(h) && h.length) this.history.set(id, h); }

  /**
   * Chart-ready history for the quotes on the board, window [from, to]. Older points are downsampled to at most
   * `points` (last value per time bucket); the last `recentHours` stay at full resolution (capped) so a live game's
   * chart is exact. Each series starts with the price in force at `from`. Times are seconds after `from`.
   */
  historyView({ hours = 48, points = 90, recentHours = 4, recentMax = 300, now = Date.now(), only = null } = {}) {
    let earliest = now;
    for (const id of this.quotes.keys()) { if (only && !only(id)) continue; const h = this.history.get(id); if (h?.length) earliest = Math.min(earliest, h[0][0]); }
    const from = Math.max(now - hours * 3600_000, earliest), bucket = Math.max(1, now - from) / points, recentFrom = now - recentHours * 3600_000;
    const series = {};
    for (const id of this.quotes.keys()) {
      if (only && !only(id)) continue;
      const h = this.history.get(id); if (!h?.length) continue;
      let start = null; const byBucket = new Map(), recent = [];
      for (const p of h) {
        if (p[0] <= from) start = p;
        else if (p[0] >= recentFrom) recent.push(p);
        else byBucket.set(Math.floor((p[0] - from) / bucket), p);
      }
      const pts = [...(start ? [[from, start[1], start[2]]] : []), ...byBucket.values(), ...recent.slice(-recentMax)];
      series[id] = pts.map((p) => [Math.round((p[0] - from) / 1000), p[1], p[2]]);
    }
    return { from, to: now, series };
  }

  snapshot() {
    return { serverTs: Date.now(), games: [...this.games.values()], quotes: [...this.quotes.values()], sources: this.sources };
  }
}
