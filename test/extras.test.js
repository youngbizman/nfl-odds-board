// "More lines" (alt spreads/totals, anytime TD, yardage milestones) on real recorded payloads from both books.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BoardStore } from '../src/store.js';
import { ExtrasStore, playerKey, fdExtraRef } from '../src/extras.js';
import { DraftKingsExtras } from '../src/sources/draftkings-extras.js';
import { FanDuelExtras } from '../src/sources/fanduel-extras.js';
import { compare } from '../src/model.js';

const DK = JSON.parse(fs.readFileSync(new URL('./fixtures/extras-dk.json', import.meta.url)));
const FD = JSON.parse(fs.readFileSync(new URL('./fixtures/extras-fd.json', import.meta.url)));
const GK = 'BAL@BUF:2026-11-01';

function setup() {
  const board = new BoardStore();
  board.upsertGame({ key: GK, home: { abbr: 'BUF' }, away: { abbr: 'BAL' }, start: '2026-11-01T18:00:00Z',
    books: { draftkings: { eventId: '34118214' }, fanduel: { eventId: '36215313' } } });
  const x = new ExtrasStore();
  const dk = new DraftKingsExtras(x, board, () => {});
  const fd = new FanDuelExtras(x, board, () => {}, { headers: () => ({}) });
  for (const [sub, data] of Object.entries(DK)) dk.applySnapshot(sub, data, 1000);
  fd.applyEventPage(GK, FD, 1000);
  const row = (kind, subject, line) => x.rows.get(ExtrasStore.rowKey(GK, { kind, subject, line }));
  return { board, x, dk, fd, row };
}

test('players match across books: suffixes, dots and accents do not matter', () => {
  assert.equal(playerKey('Kenneth Walker III'), playerKey('Kenneth Walker'));
  assert.equal(playerKey('Amon-Ra St. Brown'), playerKey('Amon-Ra St Brown'));
  assert.equal(playerKey('D.J. Moore'), playerKey('DJ Moore'));
  assert.notEqual(playerKey('Josh Allen'), playerKey('Josh Allen Jones'));
});

test('FanDuel runner names carry the number: "(+7.5)" for alt lines, "250+" for milestones', () => {
  assert.deepEqual(fdExtraRef('alt-spread', {}, { runnerName: 'Baltimore Ravens (-3.5)', result: { type: 'AWAY' } }), { kind: 'alt-spread', subject: 'away', line: -3.5 });
  assert.deepEqual(fdExtraRef('alt-total', {}, { runnerName: 'Under (44.5)', result: { type: 'UNDER' } }), { kind: 'alt-total', subject: 'under', line: 44.5 });
  assert.deepEqual(fdExtraRef('pass-yds', { marketName: 'Josh Allen - Alt Passing Yds' }, { runnerName: 'Josh Allen 250+ Yards' }), { kind: 'pass-yds', subject: 'josh-allen', name: 'Josh Allen', line: 250 });
});

test('real payloads: the same bet from both books lands on one row, and only same-number rows are compared', () => {
  const { row } = setup();
  // alt spread: BAL −3.5 is one row with both books
  const s = row('alt-spread', 'away', -3.5);
  assert.ok(s.offers.draftkings && s.offers.fanduel, 'BAL −3.5 from both books');
  assert.equal(s.offers.fanduel.odds, 255);
  // anytime TD: same player from both; DraftKings' "1st TD scorer" market is not mixed in
  const td = row('td', 'derrick-henry', null);
  assert.equal(td.offers.draftkings.odds, -230); assert.equal(td.offers.fanduel.odds, -240);
  assert.equal(compare([{ ...td.offers.draftkings, book: 'draftkings' }, { ...td.offers.fanduel, book: 'fanduel' }]).best.book, 'draftkings');
  // milestones: DK 250+ and FD 250+ compare; DK 260+ has no FanDuel twin, FD 275+ has no DraftKings twin
  const y250 = row('pass-yds', 'josh-allen', 250);
  assert.equal(y250.offers.draftkings.odds, -127); assert.equal(y250.offers.fanduel.odds, -108);
  assert.ok(row('pass-yds', 'josh-allen', 260).offers.draftkings && !row('pass-yds', 'josh-allen', 260).offers.fanduel);
  assert.ok(row('pass-yds', 'josh-allen', 275).offers.fanduel && !row('pass-yds', 'josh-allen', 275).offers.draftkings);
});

test('DraftKings socket frames move a prop price; a selection removed from the next snapshot is dropped', () => {
  const { x, dk, row } = setup();
  const sel = DK['12438'].selections.find((s) => s.label === 'Derrick Henry' && DK['12438'].markets.find((m) => m.id === s.marketId).marketType.name === 'Anytime Touchdown Scorer');
  const seen = []; x.on('row', (r) => seen.push(r));
  dk.onMessage(Buffer.from(JSON.stringify({ event: 'update', data: { data: { change: { selections: [{ id: sel.id, displayOdds: { american: '−250' } }] } } } })), 2000);
  assert.equal(row('td', 'derrick-henry', null).offers.draftkings.odds, -250);
  assert.equal(row('td', 'derrick-henry', null).offers.draftkings.prevOdds, -230);
  assert.equal(seen.length, 1);
  // next snapshot without Derrick Henry → DraftKings' offer is gone, FanDuel's stays
  dk.applySnapshot('12438', { ...DK['12438'], selections: DK['12438'].selections.filter((s) => s.id !== sel.id) }, 3000);
  const r = row('td', 'derrick-henry', null);
  assert.ok(!r.offers.draftkings && r.offers.fanduel);
});

test('FanDuel price polls update props and mark suspended runners', () => {
  const { fd, row } = setup();
  const m = Object.values(FD.attachments.markets).find((v) => v.marketType === 'ANY_TIME_TOUCHDOWN_SCORER');
  const henry = m.runners.find((r) => r.runnerName === 'Derrick Henry');
  const n = fd.applyPrices([{ marketId: m.marketId, runnerDetails: [{ selectionId: henry.selectionId, runnerStatus: 'SUSPENDED', winRunnerOdds: { americanDisplayOdds: { americanOdds: -260 } } }] }], 2000);
  assert.equal(n, 1);
  const o = row('td', 'derrick-henry', null).offers.fanduel;
  assert.equal(o.odds, -260); assert.equal(o.suspended, true);
});

test('FanDuel polls open games every 3 s and the rest every 60 s, 50 markets per request at most', async () => {
  const { fd } = setup();
  const bodies = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { bodies.push(JSON.parse(opts.body).marketIds); return new Response('[]', { status: 200 }); };
  try {
    fd.watched = () => new Set([GK]);
    await fd.tick(1000 + 2000); assert.equal(bodies.length, 0, 'polled at discovery; not due yet');
    await fd.tick(1000 + 3000); assert.equal(bodies.length, 1, 'open game: due after 3 s');
    assert.ok(bodies[0].length > 0 && bodies[0].length <= 50);
    fd.watched = () => new Set();
    for (const id of fd.markets.keys()) fd.polledAt.set(id, 10_000);
    await fd.tick(10_000 + 30_000); assert.equal(bodies.length, 1, 'nobody watching: not due before 60 s');
  } finally { globalThis.fetch = realFetch; }
});

test('tightest alt lines: lowest combined hold per game, from the best price on each side', () => {
  const { x } = setup();
  const h = x.holds(5);
  assert.ok(h.length >= 1);
  for (const e of h) { assert.ok(e.hold > -0.2 && e.hold < 0.2, `plausible hold ${e.hold}`); assert.ok(e.a.subject !== e.b.subject); }
  const spread = h.find((e) => e.kind === 'alt-spread');
  assert.equal(spread.b.line, -spread.a.line, 'spread sides pair on opposite numbers');
});

test('DraftKings more lines: isSuspended greys an offer (snapshot or a market-only frame), reopening restores it, a price-only change keeps it greyed', () => {
  const { x, dk, row } = setup();
  const td = DK['12438'];
  const sel = td.selections.find((s) => s.label === 'Derrick Henry' && td.markets.find((m) => m.id === s.marketId).marketType.name === 'Anytime Touchdown Scorer');
  const henry = () => row('td', 'derrick-henry', null).offers.draftkings;
  const frame = (d) => Buffer.from(JSON.stringify({ event: 'update', data: { data: d } }));
  assert.equal(henry().suspended, false);
  // market-only change, no price: suspended at the same price, and it cannot be the best price
  assert.equal(dk.onMessage(frame({ change: { markets: [{ id: sel.marketId, isSuspended: true, sortOrder: 1 }] } }), 2000) > 0, true);
  assert.equal(henry().suspended, true); assert.equal(henry().odds, -230);
  assert.notEqual(compare([{ book: 'draftkings', ...henry() }, { book: 'fanduel', ...row('td', 'derrick-henry', null).offers.fanduel }]).best?.book, 'draftkings');
  // a partial price change keeps it suspended
  dk.onMessage(frame({ change: { selections: [{ id: sel.id, displayOdds: { american: '−250' } }] } }), 3000);
  assert.equal(henry().odds, -250); assert.equal(henry().suspended, true);
  // reopened
  dk.onMessage(frame({ change: { markets: [{ id: sel.marketId, isSuspended: false }] } }), 4000);
  assert.equal(henry().suspended, false); assert.equal(henry().odds, -250);
  // a snapshot that says the market is suspended is the truth too
  dk.applySnapshot('12438', { ...td, markets: td.markets.map((m) => (m.id === sel.marketId ? { ...m, isSuspended: true } : m)) }, 5000);
  assert.equal(henry().suspended, true);
  dk.applySnapshot('12438', td, 6000);
  assert.equal(henry().suspended, false);
});

test('the edge relay keeps DraftKings\' availability flags', async () => {
  const { slimDk } = await import('../src/extras.js');
  const s = slimDk({ events: [], markets: [{ id: 'm', eventId: 'e', name: 'x', isSuspended: true }], selections: [{ id: 's', marketId: 'm', isSuspended: true, displayOdds: { american: '+100' } }] });
  assert.equal(s.markets[0].isSuspended, true); assert.equal(s.selections[0].isSuspended, true);
});

test('more lines go stale with their book: quiet too long, or the main feed down; stale prices never make the tightest list', () => {
  const { x } = setup();
  const t = 1000;
  x.refreshStaleness(t + 1000, {});
  assert.equal(x.status.draftkings.stale, false); assert.equal(x.status.fanduel.stale, false);
  const fresh = x.holds(50);
  assert.ok(fresh.some((h) => h.a.book === 'draftkings' || h.b.book === 'draftkings'), 'DraftKings prices count while fresh');
  // DraftKings' main feed goes down: its more-lines prices stop counting at once
  assert.equal(x.refreshStaleness(t + 2000, { draftkings: true }), true);
  assert.equal(x.status.draftkings.stale, true);
  assert.ok(x.holds(50).every((h) => h.a.book !== 'draftkings' && h.b.book !== 'draftkings'));
  // back up
  x.refreshStaleness(t + 3000, {}); assert.equal(x.status.draftkings.stale, false);
  // FanDuel quiet for longer than its limit
  x.refreshStaleness(t + 181_000 + 1, {});
  assert.equal(x.status.fanduel.stale, true);
  assert.ok(x.holds(50).every((h) => h.a.book !== 'fanduel' && h.b.book !== 'fanduel'));
});
