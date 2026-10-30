import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardStore } from '../src/store.js';

const q = (o = {}) => ({ gameKey: 'CAR@GB:2026-10-29', market: 'spread', side: 'home', book: 'fanduel', line: -3.5, odds: -114, ...o });

test('a quote is emitted only when the price or line actually changes', () => {
  const s = new BoardStore(); const seen = []; s.on('quote', (x) => seen.push(x));
  assert.equal(s.upsertQuote(q(), 1000), true);
  assert.equal(s.upsertQuote(q(), 2000), false);           // same poll result again: nothing goes to browsers
  assert.equal(s.upsertQuote(q({ odds: -110 }), 3000), true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].prevOdds, -114); assert.equal(seen[1].odds, -110); assert.equal(seen[1].updatedAt, 3000);
  assert.equal(s.upsertQuote(q({ odds: -110, line: -4 }), 4000), true);
  assert.equal(seen[2].prevLine, -3.5);
  assert.equal(s.upsertQuote(q({ odds: -110, line: -4, suspended: true }), 5000), true); // suspension is a change too
});

test('removing a market tells browsers to drop it', () => {
  const s = new BoardStore(); s.upsertQuote(q()); s.upsertQuote(q({ side: 'away', line: 3.5, odds: -106 }));
  const seen = []; s.on('quote', (x) => seen.push(x));
  s.removeQuotes('fanduel', 'CAR@GB:2026-10-29', 'spread');
  assert.equal(s.quotes.size, 0); assert.equal(seen.length, 2); assert.ok(seen.every((x) => x.removed));
});

test('book status is pushed only for meaningful changes; counters ride the heartbeat', () => {
  const s = new BoardStore(); const seen = []; s.on('source', (x) => seen.push(x));
  s.setSource('fanduel', { state: 'polling' });
  s.setSource('fanduel', { lastDataAt: 1 }); s.setSource('fanduel', { lastDataAt: 2, polls: 9 });
  assert.equal(seen.length, 1);
  assert.equal(s.sources.fanduel.lastDataAt, 2);
});

test('a book goes stale after its threshold and recovers when data arrives', () => {
  const s = new BoardStore(); const t = { draftkings: 1000, fanduel: 1000 };
  s.setSource('fanduel', { state: 'polling', lastDataAt: 10_000 });
  s.setSource('draftkings', { state: 'live', lastDataAt: 10_000 });
  s.refreshStaleness(t, 10_500);
  assert.equal(s.sources.fanduel.stale, false);
  s.refreshStaleness(t, 11_500);
  assert.equal(s.sources.fanduel.stale, true);
  s.setSource('fanduel', { lastDataAt: 11_600 }); s.refreshStaleness(t, 11_700);
  assert.equal(s.sources.fanduel.stale, false);
  s.setSource('draftkings', { state: 'down' }); s.refreshStaleness(t, 11_700);
  assert.equal(s.sources.draftkings.stale, true, 'a book that is down is stale even if its last data was recent');
});

test('price history: one point per real change, kept across restarts, and charted from the price in force at the window start', () => {
  const s = new BoardStore(); const H = 3600_000, t0 = 1_800_000_000_000;
  const q = (odds, line) => ({ gameKey: 'G', market: 'spread', side: 'home', book: 'draftkings', odds, line });
  s.upsertQuote(q(-110, -3), t0);
  s.upsertQuote(q(-110, -3), t0 + 1000);           // same price: no point
  s.upsertQuote(q(-115, -3), t0 + 50 * H);         // a move inside the 48 h window
  s.upsertQuote(q(+100, -3.5), t0 + 51 * H);       // a line move
  const id = 'G|spread|home|draftkings';
  assert.equal(s.history.get(id).length, 3);
  const v = s.historyView({ hours: 48, points: 48, now: t0 + 52 * H });
  assert.equal(v.from, t0 + 4 * H);
  assert.deepEqual(v.series[id][0], [0, -110, -3], 'starts with the price in force at the window start');
  assert.deepEqual(v.series[id].slice(1).map((p) => [p[1], p[2]]), [[-115, -3], [100, -3.5]]);
  // a new process restores the history; re-applying the current price adds nothing
  const s2 = new BoardStore(); s2.importHistory(JSON.parse(JSON.stringify(s.exportHistory(t0 + 52 * H))));
  s2.upsertQuote(q(+100, -3.5), t0 + 53 * H);
  assert.equal(s2.history.get(id).length, 3);
});

test('kickoff time does not flip between books: DraftKings\' time wins, FanDuel\'s is used only alone', () => {
  const s = new BoardStore(); const key = 'ARI@DAL:2026-11-01';
  s.upsertGame({ key, start: '2026-11-01T18:01:00.000Z', books: { fanduel: { eventId: 'f1', live: false } } });
  assert.equal(s.games.get(key).start, '2026-11-01T18:01:00.000Z');             // only FanDuel so far
  s.upsertGame({ key, start: '2026-11-01T18:00:00.000Z', books: { draftkings: { eventId: 'd1', live: false } } });
  assert.equal(s.games.get(key).start, '2026-11-01T18:00:00.000Z');
  assert.equal(s.upsertGame({ key, start: '2026-11-01T18:01:00.000Z', books: { fanduel: { eventId: 'f1', live: false } } }), false); // FanDuel re-snapshot: no change
  assert.equal(s.games.get(key).start, '2026-11-01T18:00:00.000Z');
  s.upsertGame({ key, books: { fanduel: { eventId: 'f1', live: true } } });      // a live flag without a time keeps it
  assert.equal(s.games.get(key).start, '2026-11-01T18:00:00.000Z');
});
