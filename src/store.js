// In-memory board: the single place both book workers write into and all browsers read from.
// One process holds one copy; browsers get a snapshot on connect and deltas afterwards.
import { EventEmitter } from 'node:events';
import { BOOKS } from './model.js';

export class BoardStore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.games = new Map();   // gameKey -> Game
    this.quotes = new Map();  // `${gameKey}|${market}|${side}|${book}` -> Quote
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
   * Insert/replace a quote. Only emits when price or line actually moved, so idle polls cost nothing downstream.
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
    const before = JSON.stringify([s.state, s.stale, s.mode, s.region, s.lastError, s.lastSnapshotAt, s.reconnects]);
    Object.assign(s, patch);
    const after = JSON.stringify([s.state, s.stale, s.mode, s.region, s.lastError, s.lastSnapshotAt, s.reconnects]);
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

  snapshot() {
    return { serverTs: Date.now(), games: [...this.games.values()], quotes: [...this.quotes.values()], sources: this.sources };
  }
}
