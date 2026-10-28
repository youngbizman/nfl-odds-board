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
  ['ARI', 'Arizona', 'Cardinals'], ['ATL', 'Atlanta', 'Falcons'], ['BAL', 'Baltimore', 'Ravens'], ['BUF', 'Buffalo', 'Bills'],
  ['CAR', 'Carolina', 'Panthers'], ['CHI', 'Chicago', 'Bears'], ['CIN', 'Cincinnati', 'Bengals'], ['CLE', 'Cleveland', 'Browns'],
  ['DAL', 'Dallas', 'Cowboys'], ['DEN', 'Denver', 'Broncos'], ['DET', 'Detroit', 'Lions'], ['GB', 'Green Bay', 'Packers'],
  ['HOU', 'Houston', 'Texans'], ['IND', 'Indianapolis', 'Colts'], ['JAX', 'Jacksonville', 'Jaguars'], ['KC', 'Kansas City', 'Chiefs'],
  ['LV', 'Las Vegas', 'Raiders'], ['LAC', 'Los Angeles', 'Chargers'], ['LAR', 'Los Angeles', 'Rams'], ['MIA', 'Miami', 'Dolphins'],
  ['MIN', 'Minnesota', 'Vikings'], ['NE', 'New England', 'Patriots'], ['NO', 'New Orleans', 'Saints'], ['NYG', 'New York', 'Giants'],
  ['NYJ', 'New York', 'Jets'], ['PHI', 'Philadelphia', 'Eagles'], ['PIT', 'Pittsburgh', 'Steelers'], ['SF', 'San Francisco', '49ers'],
  ['SEA', 'Seattle', 'Seahawks'], ['TB', 'Tampa Bay', 'Buccaneers'], ['TEN', 'Tennessee', 'Titans'], ['WAS', 'Washington', 'Commanders'],
];
const BY_NICK = new Map(TEAMS.map(([abbr, city, nick]) => [nick.toLowerCase(), { abbr, city, nick, name: `${city} ${nick}` }]));

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
  const live = quotes.filter((q) => q && q.odds != null);
  if (!live.length) return null;
  const lines = new Set(live.map((q) => q.line ?? 'ml'));
  if (lines.size > 1) return { conflict: true, offers: live.slice().sort((a, b) => (b.odds ?? -Infinity) - (a.odds ?? -Infinity)) };
  const sorted = live.slice().sort((a, b) => b.odds - a.odds);
  const best = sorted[0];
  const tiedBooks = sorted.filter((q) => q.odds === best.odds).map((q) => q.book);
  return { conflict: false, best, books: tiedBooks, offers: sorted };
}
