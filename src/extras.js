// "More lines": alternate spreads/totals and player props from both books, matched on the same number.
//
// A row is one bettable thing that both books can offer: e.g. "BUF −6.5 (alt spread)", "Over 44.5 (alt total)",
// "Josh Allen anytime TD", "Josh Allen 250+ passing yards". Each book puts its own offer on the row; the page ranks
// offers with the same compare() as the main board, so "best" only ever means: same row, same number, higher odds.
//
// Kept apart from the main board on purpose: thousands of prices that only matter to someone who opened a game's
// drop-down. They have their own workers, their own cadence and their own stream per game, so a busy Sunday of
// props can never slow the main board down.
import { EventEmitter } from 'node:events';
import { parseAmerican, bestHold, oppositeLine } from './model.js';

export const KINDS = {
  'alt-spread': 'Alt spread', 'alt-total': 'Alt total', td: 'Anytime TD',
  'pass-yds': 'Passing yards', 'rush-yds': 'Rushing yards', 'rec-yds': 'Receiving yards', receptions: 'Receptions',
};

/** Same player, both books: "Kenneth Walker III" = "Kenneth Walker", "Amon-Ra St. Brown" = "Amon-Ra St Brown". */
export function playerKey(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[.'’]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------- DraftKings: subcategory → kind, and one selection → one row ----------
export const DK_SUBCATS = { 13195: 'alt-spread', 13196: 'alt-total', 12438: 'td', 16569: 'pass-yds', 16571: 'rush-yds', 16570: 'rec-yds', 16821: 'receptions' };
const DK_MILESTONE_SUFFIX = / (Passing Yards|Rushing Yards|Receiving Yards|Receptions)$/;

export function dkExtraRow(kind, market, sel) {
  const odds = parseAmerican(sel.displayOdds?.american); if (odds == null) return null;
  const player = sel.participants?.find((p) => p.type === 'Player')?.name;
  if (kind === 'alt-spread' || kind === 'alt-total') {
    const subject = { Home: 'home', Away: 'away', Over: 'over', Under: 'under' }[sel.outcomeType];
    if (!subject || typeof sel.points !== 'number') return null;
    return { kind, subject, line: sel.points, odds };
  }
  if (kind === 'td') {
    if (market?.marketType?.name && market.marketType.name !== 'Anytime Touchdown Scorer') return null; // not 1st TD / 2+ TDs
    const name = player || sel.label; if (!name || /^no /i.test(name)) return null;
    return { kind, subject: playerKey(name), name, line: null, odds };
  }
  const name = player || String(market?.name || '').replace(DK_MILESTONE_SUFFIX, '');
  const line = sel.milestoneValue ?? parseInt(sel.label, 10);
  if (!name || !Number.isFinite(line)) return null;
  return { kind, subject: playerKey(name), name, line, odds };
}

/** What the edge relays: only the fields the decoder reads (≈ a quarter of DraftKings' payload). */
export function slimDk(data) {
  return {
    events: (data.events || []).map((e) => ({ id: e.id })),
    markets: (data.markets || []).map((m) => ({ id: m.id, eventId: m.eventId, name: m.name, marketType: { name: m.marketType?.name } })),
    selections: (data.selections || []).map((s) => ({ id: s.id, marketId: s.marketId, label: s.label, displayOdds: { american: s.displayOdds?.american },
      points: s.points, outcomeType: s.outcomeType, milestoneValue: s.milestoneValue,
      participants: (s.participants || []).filter((p) => p.type === 'Player').map((p) => ({ name: p.name, type: p.type })) })),
  };
}

// ---------- FanDuel: market type → kind, and one runner → one row ----------
const FD_KINDS = [[/^ALTERNATE_HANDICAP$/, 'alt-spread'], [/^ALTERNATE_TOTAL$/, 'alt-total'], [/^ANY_TIME_TOUCHDOWN_SCORER$/, 'td'],
  [/^PLAYER_X_ALT_PASSING_YARDS/, 'pass-yds'], [/^PLAYER_X_ALT_RUSHING_YARDS/, 'rush-yds'], [/^PLAYER_X_ALT_RECEIVING_YARDS/, 'rec-yds'], [/^PLAYER_X_ALT_RECEPTIONS/, 'receptions']];
export const fdKind = (marketType) => FD_KINDS.find(([re]) => re.test(marketType || ''))?.[1] || null;

/** Static part of a FanDuel runner (from the event page): which row it is. Prices come later from getMarketPrices. */
export function fdExtraRef(kind, market, runner) {
  const name = String(runner.runnerName || '');
  if (kind === 'alt-spread' || kind === 'alt-total') {
    const subject = { HOME: 'home', AWAY: 'away', OVER: 'over', UNDER: 'under' }[runner.result?.type];
    const m = /\(([+-]?\d+(?:\.\d+)?)\)\s*$/.exec(name);
    if (!subject || !m) return null;
    return { kind, subject, line: Number(m[1]) };
  }
  if (kind === 'td') { if (!name || /^no /i.test(name)) return null; return { kind, subject: playerKey(name), name, line: null }; }
  const player = String(market.marketName || '').split(' - ')[0].trim();
  const m = /(\d+)\+/.exec(name);
  if (!player || !m) return null;
  return { kind, subject: playerKey(player), name: player, line: Number(m[1]) };
}
export const fdOdds = (runner) => parseAmerican(runner.winRunnerOdds?.americanDisplayOdds?.americanOdds);
export const fdSuspended = (runner) => !!runner.runnerStatus && runner.runnerStatus !== 'ACTIVE';

// ---------- the store ----------
export class ExtrasStore extends EventEmitter {
  constructor() {
    super(); this.setMaxListeners(0);
    this.rows = new Map();   // rowKey -> { key, gameKey, kind, subject, name, line, offers: { book: { odds, suspended, updatedAt, prevOdds } } }
    this.byGame = new Map(); // gameKey -> Set(rowKey)
    this.status = { draftkings: { lastSnapshotAt: null, lastDataAt: null, detail: '' }, fanduel: { lastSnapshotAt: null, lastDataAt: null, detail: '' } };
  }
  static rowKey(gameKey, r) { return `${gameKey}|${r.kind}|${r.subject}|${r.line ?? ''}`; }

  /** One book's offer on one row. Emits 'row' only when the price or suspension changed. */
  upsert(book, gameKey, r, now = Date.now()) {
    const key = ExtrasStore.rowKey(gameKey, r);
    let row = this.rows.get(key);
    if (!row) {
      row = { key, gameKey, kind: r.kind, subject: r.subject, name: r.name || null, line: r.line ?? null, offers: {} };
      this.rows.set(key, row);
      if (!this.byGame.has(gameKey)) this.byGame.set(gameKey, new Set());
      this.byGame.get(gameKey).add(key);
    }
    if (!row.name && r.name) row.name = r.name;
    const prev = row.offers[book]; const suspended = !!r.suspended;
    if (prev && prev.odds === r.odds && prev.suspended === suspended) { prev.seenAt = now; return false; }
    row.offers[book] = { odds: r.odds, suspended, updatedAt: now, seenAt: now, prevOdds: prev ? prev.odds : null };
    this.status[book].lastDataAt = now;
    this.emit('row', row);
    return true;
  }

  /** Drop one book's offer (market taken down). */
  drop(book, key) {
    const row = this.rows.get(key); if (!row?.offers[book]) return;
    delete row.offers[book];
    if (!Object.keys(row.offers).length) { this.rows.delete(key); this.byGame.get(row.gameKey)?.delete(key); }
    this.emit('row', row);
  }

  /** After a full snapshot from `book` (of one kind, or of everything for some games): what it did not contain is gone. */
  sweep(book, kind, seenSince, gameKeys = null) {
    for (const row of [...this.rows.values()]) {
      const o = row.offers[book];
      if (o && (!kind || row.kind === kind) && (!gameKeys || gameKeys.has(row.gameKey)) && o.seenAt < seenSince) this.drop(book, row.key);
    }
  }

  forGame(gameKey) { return [...(this.byGame.get(gameKey) || [])].map((k) => this.rows.get(k)).filter(Boolean); }

  /** The tightest alt lines on the board: per game and kind, the lowest hold from the best price on each side (either book). */
  holds(limit = 8) {
    const out = [];
    for (const [gk, keys] of this.byGame) {
      const rows = [...keys].map((k) => this.rows.get(k)).filter(Boolean);
      for (const [kind, A, B, pair] of [['alt-spread', 'away', 'home', oppositeLine], ['alt-total', 'over', 'under', (l) => l]]) {
        const offers = (subj) => rows.filter((r) => r.kind === kind && r.subject === subj)
          .flatMap((r) => Object.entries(r.offers).map(([book, o]) => ({ book, odds: o.odds, line: r.line, suspended: o.suspended, subject: subj })));
        const h = bestHold(offers(A), offers(B), pair);
        if (h) out.push({ gameKey: gk, kind, hold: h.hold, a: h.a, b: h.b });
      }
    }
    return out.sort((x, y) => x.hold - y.hold).slice(0, limit);
  }

  /** Per game: how many rows each kind has, and how many both books price (the comparable ones). */
  summary() {
    const out = {};
    for (const [gk, keys] of this.byGame) {
      const s = { rows: 0, both: 0, kinds: {} };
      for (const k of keys) { const r = this.rows.get(k); if (!r) continue; s.rows++; if (r.offers.draftkings && r.offers.fanduel) s.both++; s.kinds[r.kind] = (s.kinds[r.kind] || 0) + 1; }
      if (s.rows) out[gk] = s;
    }
    return out;
  }
}
