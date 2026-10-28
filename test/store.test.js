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
