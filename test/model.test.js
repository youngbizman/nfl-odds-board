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
