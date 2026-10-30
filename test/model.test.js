import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTeam, gameKey, parseAmerican, americanToDecimal, bestPrice } from '../src/model.js';

test('team names from both books resolve to the same team', () => {
  for (const name of ['GB Packers', 'Green Bay Packers', 'Packers']) assert.equal(resolveTeam(name).abbr, 'GB');
  assert.equal(resolveTeam('LA Chargers').abbr, 'LAC');
  assert.equal(resolveTeam('Los Angeles Rams').abbr, 'LAR');
  assert.equal(resolveTeam('NY Jets').abbr, 'NYJ');
  assert.equal(resolveTeam('San Francisco 49ers').abbr, 'SF');
  assert.equal(resolveTeam('Over'), null);
  assert.equal(resolveTeam(undefined), null);
});

test('game key uses the US-Eastern game date, so an 8:15 pm ET kickoff (00:15 UTC) keeps its own date', () => {
  const car = resolveTeam('CAR Panthers'), gb = resolveTeam('Green Bay Packers');
  assert.equal(gameKey(car, gb, '2026-10-30T00:15:00.0000000Z'), 'CAR@GB:2026-10-29'); // DraftKings format
  assert.equal(gameKey(car, gb, '2026-10-30T00:15:00.000Z'), 'CAR@GB:2026-10-29');      // FanDuel format
});

test('american odds parse from both books, including the unicode minus DraftKings uses', () => {
  assert.equal(parseAmerican('−192'), -192);
  assert.equal(parseAmerican('+160'), 160);
  assert.equal(parseAmerican(-110), -110);
  assert.equal(parseAmerican(-176.0), -176);
  assert.equal(parseAmerican(''), null);
  assert.equal(parseAmerican('EVEN?'), null);
  assert.equal(americanToDecimal(100), 2);
  assert.ok(Math.abs(americanToDecimal(-110) - 1.909) < 0.001);
});

test('best price: higher odds wins on the same number', () => {
  const r = bestPrice([{ book: 'draftkings', line: null, odds: 270 }, { book: 'fanduel', line: null, odds: 280 }]);
  assert.equal(r.conflict, false); assert.equal(r.best.book, 'fanduel'); assert.deepEqual(r.books, ['fanduel']);
  const neg = bestPrice([{ book: 'draftkings', line: -3.5, odds: -108 }, { book: 'fanduel', line: -3.5, odds: -112 }]);
  assert.equal(neg.best.book, 'draftkings');
});

test('best price: a tie names both books', () => {
  const r = bestPrice([{ book: 'draftkings', line: null, odds: 160 }, { book: 'fanduel', line: null, odds: 160 }]);
  assert.deepEqual(r.books.sort(), ['draftkings', 'fanduel']);
});

test('best price: different lines are a conflict, never a winner', () => {
  const r = bestPrice([{ book: 'draftkings', line: 7, odds: -112 }, { book: 'fanduel', line: 6.5, odds: 100 }]);
  assert.equal(r.conflict, true); assert.equal(r.offers.length, 2); assert.equal(r.best, undefined);
});

test('best price: suspended or missing prices are ignored', () => {
  const r = bestPrice([{ book: 'draftkings', line: null, odds: 300, suspended: true }, { book: 'fanduel', line: null, odds: 280 }]);
  assert.equal(r.best.book, 'fanduel');
  assert.equal(bestPrice([null, { book: 'fanduel', odds: null }]), null);
});

test('compare(): best, tie, different lines, only-available, nothing eligible', async () => {
  const { compare, decimalOdds } = await import('../src/model.js');
  const dk = (o) => ({ book: 'draftkings', line: -3.5, odds: -110, ...o }), fd = (o) => ({ book: 'fanduel', line: -3.5, odds: -105, ...o });
  assert.equal(compare([dk(), fd()]).kind, 'best'); assert.equal(compare([dk(), fd()]).best.book, 'fanduel');
  assert.equal(compare([dk(), fd({ odds: -110 })]).kind, 'tie');
  assert.equal(compare([dk(), fd({ line: -3 })]).kind, 'different');
  const s = compare([dk(), fd({ suspended: true, odds: 300 })]); assert.equal(s.kind, 'partial'); assert.equal(s.best.book, 'draftkings');
  assert.equal(compare([dk({ stale: true }), fd()]).best.book, 'fanduel', 'a stale book can never win');
  assert.equal(compare([dk(), null]).kind, 'partial');
  assert.equal(compare([dk({ stale: true }), fd({ suspended: true })]).kind, 'none');
  assert.equal(compare([null, null]).kind, 'none');
  assert.equal(decimalOdds(-340).toFixed(3), '1.294'); assert.equal(decimalOdds(-350).toFixed(3), '1.286'); assert.equal(decimalOdds(150), 2.5);
});

test('cents: the bettor\'s distance between two prices', async () => {
  const { cents } = await import('../src/model.js');
  assert.equal(cents(-106, -108), 2);
  assert.equal(cents(164, 160), 4);
  assert.equal(cents(105, -105), 10);
  assert.equal(cents(-110, -110), 0);
});

test('hold: best price per side across both books, only on matching lines; negative = arbitrage', async () => {
  const { bestHold, oppositeLine } = await import('../src/model.js');
  const o = (book, odds, line = null, x = {}) => ({ book, odds, line, ...x });
  // moneyline: CAR +164 (DK) and GB −190 (FD) → 37.9% + 65.5% − 1 = 3.4%
  const ml = bestHold([o('draftkings', 164), o('fanduel', 160)], [o('draftkings', -198), o('fanduel', -190)]);
  assert.equal(ml.a.book, 'draftkings'); assert.equal(ml.b.book, 'fanduel');
  assert.ok(Math.abs(ml.hold - (100 / 264 + 190 / 290 - 1)) < 1e-9);
  // spread: +3.5 pairs with −3.5 only; a −3 on the other side is ignored
  const sp = bestHold([o('draftkings', -110, 3.5), o('fanduel', -102, 3)], [o('draftkings', -110, -3.5), o('fanduel', -118, -3)], oppositeLine);
  assert.ok(sp);
  // a suspended price never makes a market look tight
  assert.equal(bestHold([o('draftkings', 300, null, { suspended: true })], [o('fanduel', -110)]), null);
  // books disagree enough → arbitrage (negative hold)
  assert.ok(bestHold([o('draftkings', 120)], [o('fanduel', 110)]).hold < 0);
});

test('fair line: each book de-vigged, books averaged; EV of a price against it', async () => {
  const { fairProb, fairAmerican, ev } = await import('../src/model.js');
  assert.equal(fairProb([[-110, -110]]), 0.5);
  const p = fairProb([[-200, 170]]);                       // 66.7% and 37.0% → 64.3% fair
  assert.ok(Math.abs(p - (2 / 3) / (2 / 3 + 100 / 270)) < 1e-12);
  assert.equal(fairAmerican(p), -180);
  assert.equal(fairAmerican(1 - p), 180);
  assert.ok(Math.abs(fairProb([[-110, -110], [-120, 100]]) - (0.5 + (120 / 220) / (120 / 220 + 0.5)) / 2) < 1e-12, 'two books are averaged');
  assert.equal(fairProb([[null, -110]]), null);
  assert.ok(Math.abs(ev(100, 0.5)) < 1e-12);
  assert.ok(ev(-105, 0.52) > 0 && ev(-120, 0.52) < 0);
});

test('ranking is by payout: −100 and +100 both pay 2.0, so they tie (and bestPrice agrees)', async () => {
  const { compare, bestPrice, bestHold } = await import('../src/model.js');
  const c = compare([{ book: 'draftkings', odds: -100, line: 3 }, { book: 'fanduel', odds: 100, line: 3 }]);
  assert.equal(c.kind, 'tie'); assert.deepEqual(c.books.sort(), ['draftkings', 'fanduel']);
  const b = bestPrice([{ book: 'draftkings', odds: -100, line: null }, { book: 'fanduel', odds: 100, line: null }]);
  assert.deepEqual(b.books.sort(), ['draftkings', 'fanduel']);
  // away from ±100 nothing changes
  assert.equal(compare([{ book: 'draftkings', odds: -105, line: null }, { book: 'fanduel', odds: 100, line: null }]).best.book, 'fanduel');
  assert.equal(compare([{ book: 'draftkings', odds: 102, line: null }, { book: 'fanduel', odds: -100, line: null }]).best.book, 'draftkings');
  assert.equal(compare([{ book: 'draftkings', odds: -110, line: null }, { book: 'fanduel', odds: -112, line: null }]).best.book, 'draftkings');
  // hold is computed from what each price pays: −100 / +100 on the two sides = exactly 0
  const h = bestHold([{ book: 'draftkings', odds: -100, line: null }], [{ book: 'fanduel', odds: 100, line: null }]);
  assert.ok(Math.abs(h.hold) < 1e-12);
});

test('"EVEN" parses as +100', async () => {
  const { parseAmerican } = await import('../src/model.js');
  assert.equal(parseAmerican('EVEN'), 100); assert.equal(parseAmerican('even'), 100); assert.equal(parseAmerican('+100'), 100);
});

test('game day is the Toronto calendar day, daylight saving included', async () => {
  const { torontoDate } = await import('../src/model.js');
  const { leagueGameKey } = await import('../src/leagues.js');
  // EDT (UTC−4): 04:30 UTC = 00:30 in Toronto, already the next day (a fixed UTC−5 said the day before)
  assert.equal(torontoDate('2026-10-02T04:30:00Z'), '2026-10-02');
  assert.equal(torontoDate('2026-10-02T03:59:00Z'), '2026-10-01');
  // EST (UTC−5): 04:30 UTC = 23:30 the day before
  assert.equal(torontoDate('2026-11-20T04:30:00Z'), '2026-11-19');
  assert.equal(torontoDate('2026-11-20T05:00:00Z'), '2026-11-20');
  // the change-over nights
  assert.equal(torontoDate('2026-11-01T05:30:00Z'), '2026-11-01'); // 01:30 EDT→EST night
  assert.equal(torontoDate('2026-03-08T06:30:00Z'), '2026-03-08'); // 02:30 UTC−4 after the spring change
  const t = { key: 'A' }, u = { key: 'B' };
  assert.equal(leagueGameKey('ncaaf', t, u, '2026-10-02T04:30:00Z'), 'ncaaf:A@B:2026-10-02');
});

test('impossible American odds (0, between −100 and +100) are rejected, not ranked', async () => {
  const { parseAmerican } = await import('../src/model.js');
  for (const v of [0, '0', 50, '-99', '+99', 99.4]) assert.equal(parseAmerican(v), null, String(v));
  assert.equal(parseAmerican(-100), -100); assert.equal(parseAmerican('−110'), -110); assert.equal(parseAmerican(150), 150);
});
