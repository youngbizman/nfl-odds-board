// Shared model: both books are normalized into these shapes.
//
//  Game  = one NFL matchup (home/away/start time/status) with the id each book uses for it
//  Quote = one price: game + market (moneyline|spread|total) + side (home|away|over|under)
//          + line (points, null for moneyline) + american odds + which book + timestamps
//
// Everything here is plain data + pure helper functions (no I/O).

export const MARKETS = ['spread', 'total', 'moneyline'];
export const SIDES = { moneyline: ['away', 'home'], spread: ['away', 'home'], total: ['over', 'under'] };
export const BOOKS = ['draftkings', 'fanduel'];
export const BOOK_LABEL = { draftkings: 'DraftKings', fanduel: 'FanDuel' };

// Canonical NFL teams. Both books use different names ("GB Packers" vs "Green Bay Packers"),
// but nicknames are unique in the NFL, so we match on the nickname.
const TEAMS = [
  ['ARI', 'Arizona', 'Cardinals', '#97233F'], ['ATL', 'Atlanta', 'Falcons', '#A71930'], ['BAL', 'Baltimore', 'Ravens', '#241773'], ['BUF', 'Buffalo', 'Bills', '#00338D'],
  ['CAR', 'Carolina', 'Panthers', '#0085CA'], ['CHI', 'Chicago', 'Bears', '#C83803'], ['CIN', 'Cincinnati', 'Bengals', '#FB4F14'], ['CLE', 'Cleveland', 'Browns', '#FF3C00'],
  ['DAL', 'Dallas', 'Cowboys', '#869397'], ['DEN', 'Denver', 'Broncos', '#FB4F14'], ['DET', 'Detroit', 'Lions', '#0076B6'], ['GB', 'Green Bay', 'Packers', '#FFB612'],
  ['HOU', 'Houston', 'Texans', '#A71930'], ['IND', 'Indianapolis', 'Colts', '#4C8CD6'], ['JAX', 'Jacksonville', 'Jaguars', '#9F792C'], ['KC', 'Kansas City', 'Chiefs', '#E31837'],
  ['LV', 'Las Vegas', 'Raiders', '#A5ACAF'], ['LAC', 'Los Angeles', 'Chargers', '#0080C6'], ['LAR', 'Los Angeles', 'Rams', '#FFA300'], ['MIA', 'Miami', 'Dolphins', '#008E97'],
  ['MIN', 'Minnesota', 'Vikings', '#4F2683'], ['NE', 'New England', 'Patriots', '#C60C30'], ['NO', 'New Orleans', 'Saints', '#D3BC8D'], ['NYG', 'New York', 'Giants', '#0B2265'],
  ['NYJ', 'New York', 'Jets', '#125740'], ['PHI', 'Philadelphia', 'Eagles', '#004C54'], ['PIT', 'Pittsburgh', 'Steelers', '#FFB612'], ['SF', 'San Francisco', '49ers', '#AA0000'],
  ['SEA', 'Seattle', 'Seahawks', '#69BE28'], ['TB', 'Tampa Bay', 'Buccaneers', '#D50A0A'], ['TEN', 'Tennessee', 'Titans', '#4B92DB'], ['WAS', 'Washington', 'Commanders', '#5A1414'],
];
const BY_NICK = new Map(TEAMS.map(([abbr, city, nick, color]) => [nick.toLowerCase(), { abbr, city, nick, name: `${city} ${nick}`, color }]));

/** "GB Packers" | "Green Bay Packers" | "Packers" -> canonical team or null */
export function resolveTeam(raw) {
  if (!raw) return null;
  const words = String(raw).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
  for (let i = words.length - 1; i >= 0; i--) {
    const hit = BY_NICK.get(words[i].toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Stable id for a matchup. Same game at both books -> same key. Date guards against rematches. */
export function gameKey(away, home, startIso) {
  const d = new Date(startIso);
  // A game is identified by its calendar date in US Eastern time (NFL "game day"), so a 1:00 am UTC kickoff
  // still belongs to the evening before.
  const et = new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  return `${away.abbr}@${home.abbr}:${et}`;
}

/** "+160" | "−192" (unicode minus) | -110 -> integer american odds */
export function parseAmerican(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).replace('−', '-').replace('+', '').trim();
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function americanToDecimal(a) {
  if (a == null) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

export function fmtAmerican(a) {
  if (a == null) return '—';
  return a > 0 ? `+${a}` : `${a}`;
}

export function fmtLine(market, side, line) {
  if (line == null) return '';
  if (market === 'total') return `${side === 'over' ? 'O' : 'U'} ${line}`;
  return line > 0 ? `+${line}` : `${line}`;
}

/**
 * Best-price policy.
 *  - Moneyline: higher american odds wins (bettor gets paid more).
 *  - Spread / total: prices are only comparable on the SAME number. If every book posts the same line,
 *    the best odds wins. If books disagree on the line (−3 −110 vs −3.5 +100) we do NOT pretend they are
 *    equal: we return `conflict: true` and the UI shows both offers side by side, un-ranked.
 *    (A fairer approach — converting half-points to price with a push chart — is noted in the README as future work.)
 *
 * quotes: Quote[] for one game/market/side, one per book.
 */
export function bestPrice(quotes) {
  const live = quotes.filter((q) => q && q.odds != null && !q.suspended); // a suspended price cannot be bet, so it cannot be best
  if (!live.length) return null;
  const lines = new Set(live.map((q) => q.line ?? 'ml'));
  if (lines.size > 1) return { conflict: true, offers: live.slice().sort((a, b) => (b.odds ?? -Infinity) - (a.odds ?? -Infinity)) };
  const sorted = live.slice().sort((a, b) => b.odds - a.odds);
  const best = sorted[0];
  const tiedBooks = sorted.filter((q) => q.odds === best.odds).map((q) => q.book);
  return { conflict: false, best, books: tiedBooks, offers: sorted };
}

/**
 * Compare the two books' offers for one game/market/side, the way the board shows it.
 * offer = { book, line, odds, suspended?, stale? }  (stale = the book's feed is stale/down)
 * Eligible = exists, has odds, not suspended, book live.
 * Returns { kind, best?, books?, eligible, offers } with kind:
 *   'best'      both eligible, same line, one has higher odds
 *   'tie'       both eligible, same line, same odds
 *   'different' both eligible, different lines → shown side by side, nobody crowned
 *   'partial'   exactly one eligible ("only available offer"); the other is shown with its reason
 *   'none'      nothing eligible (both stale/suspended/missing)
 * Shared by the server tests and the browser (served at /lib/model.js), so the page can never drift from the tested rule.
 */
export function compare(offers) {
  const present = offers.filter((o) => o && o.odds != null);
  const eligible = present.filter((o) => !o.suspended && !o.stale);
  if (eligible.length === 0) return { kind: 'none', eligible, offers: present };
  if (eligible.length === 1) return { kind: 'partial', best: eligible[0], eligible, offers: present };
  if (new Set(eligible.map((o) => o.line ?? 'ml')).size > 1) return { kind: 'different', eligible, offers: eligible };
  const sorted = eligible.slice().sort((a, b) => b.odds - a.odds);
  const books = sorted.filter((o) => o.odds === sorted[0].odds).map((o) => o.book);
  return books.length > 1 ? { kind: 'tie', best: sorted[0], books, eligible, offers: sorted } : { kind: 'best', best: sorted[0], books, eligible, offers: sorted };
}

export function decimalOdds(a) { return a == null ? null : a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }

/** Chance a price implies (includes the book's margin): −190 → 0.655, +164 → 0.379. */
export function impliedProb(a) { const d = decimalOdds(a); return d ? 1 / d : null; }

/**
 * How much better price `a` is than `b`, in "cents" — bettors' unit, where −105 and +105 are 10 cents apart:
 * −106 vs −108 → 2, +164 vs +160 → 4, +105 vs −105 → 10.
 */
export function cents(a, b) { const f = (x) => (x > 0 ? x - 100 : x + 100); return f(a) - f(b); }

/**
 * The lowest "hold" you can get on a two-sided market by taking the best open price on each side from either book.
 * hold = implied(side A) + implied(side B) − 1. Positive = the books' combined margin; NEGATIVE = an arbitrage
 * (backing both sides guarantees a profit). Sides only pair on matching lines: spread +3 with −3, total over 47.5 with
 * under 47.5 (`pair` maps a side-A line to the side-B line). Suspended or stale prices never count.
 * offers: [{ book, odds, line, suspended, stale }]. Returns { hold, a, b } or null.
 */
export function bestHold(sideA, sideB, pair = (l) => l) {
  const ok = (o) => o && o.odds != null && !o.suspended && !o.stale;
  const top = (list, line) => list.filter((o) => ok(o) && (o.line ?? null) === line).sort((x, y) => y.odds - x.odds)[0];
  let best = null;
  for (const line of new Set(sideA.filter(ok).map((o) => o.line ?? null))) {
    const a = top(sideA, line), b = top(sideB, pair(line));
    if (!a || !b) continue;
    const hold = impliedProb(a.odds) + impliedProb(b.odds) - 1;
    if (!best || hold < best.hold) best = { hold, a, b };
  }
  return best;
}
export const oppositeLine = (l) => (l == null ? null : l === 0 ? 0 : -l);
