import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FanDuelSource } from '../src/sources/fanduel.js';
import { fixture, fresh, quiet, waitFor, quotesOf, sleep } from './helpers.js';

const SNAP = fixture('fd-snapshot.json');
const PRICES = fixture('fd-prices.json'); // a real getMarketPrices response for the same markets

function source(opts = {}) { const { store, metrics } = fresh(); return { store, metrics, fd: new FanDuelSource(store, metrics, quiet, opts) }; }

test('snapshot: three games, nine game-line markets polled, props ignored, six prices per game', () => {
  const { store, fd } = source();
  const n = fd.applySnapshot(SNAP, 1000);
  assert.deepEqual(n, { games: 3, markets: 9 });
  assert.equal(fd.marketIds.length, 9);
  for (const g of store.games.values()) assert.equal(quotesOf(store, 'fanduel').filter((q) => q.gameKey === g.key).length, 6, g.key);
  const bal = store.quotes.get('BAL@BUF:2026-11-01|spread|away|fanduel');
  assert.equal(bal.line, 3); assert.equal(bal.odds, 100);
});

test('a real price response applies; an in-place line move is picked up from the handicap', () => {
  const { store, fd } = source();
  fd.applySnapshot(SNAP, 1000);
  fd.applyPrices(PRICES, 2000); // same moment as the snapshot → few or no changes
  const moved = structuredClone(PRICES);
  const spread = moved.find((m) => m.marketId === '734.192676410'); // BAL @ BUF spread
  for (const r of spread.runnerDetails) { r.handicap = r.handicap > 0 ? 3.5 : -3.5; r.winRunnerOdds.americanDisplayOdds.americanOdds = -110; }
  assert.equal(fd.applyPrices(moved, 3000), 2);
  const q = store.quotes.get('BAL@BUF:2026-11-01|spread|away|fanduel');
  assert.equal(q.line, 3.5); assert.equal(q.prevLine, 3); assert.equal(q.odds, -110);
  // a market switching to in-play flips the game to live
  moved[0].inplay = true; fd.applyPrices(moved, 4000);
  assert.equal(store.games.get('BAL@BUF:2026-11-01').status, 'live');
});

test('a suspended runner is shown as suspended, not removed', () => {
  const { store, fd } = source();
  fd.applySnapshot(SNAP, 1000);
  const p = structuredClone(PRICES); p[0].runnerDetails[0].runnerStatus = 'SUSPENDED';
  fd.applyPrices(p, 2000);
  assert.equal(quotesOf(store, 'fanduel').filter((q) => q.suspended).length, 1);
});

// ---------- against a fake FanDuel ----------
async function fakeFanDuel() {
  const state = { mode: 'ok', polls: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/snapshot')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(SNAP)); }
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      state.polls++; state.bodies.push(JSON.parse(body));
      if (state.mode === '429') { res.writeHead(429, { 'retry-after': '1' }); return res.end('slow down'); }
      if (state.mode === '500') { res.writeHead(500); return res.end('boom'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(PRICES));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { state, snapshotUrl: `${base}/snapshot`, pricesUrl: `${base}/prices`, close: () => server.close() };
}

test('polls all markets in one request on a fixed beat', async () => {
  const fake = await fakeFanDuel();
  const { store, metrics, fd } = source({ snapshotUrl: fake.snapshotUrl, pricesUrl: fake.pricesUrl, pollMs: 100 });
  try {
    await fd.start();
    await waitFor(() => metrics.fd.polls >= 8, 3000);
    assert.equal(fake.state.bodies[0].marketIds.length, 9, 'one request carries every market');
    const { p50 } = metrics.fd.pollInterval.stats();
    assert.ok(p50 >= 95 && p50 <= 130, `start-to-start interval ~100 ms, got ${p50}`);
    assert.equal(store.sources.fanduel.state, 'polling');
  } finally { fd.stop(); fake.close(); }
});

test('backs off on 429 (honouring Retry-After), shows the error, and recovers', async () => {
  const fake = await fakeFanDuel();
  const { store, metrics, fd } = source({ snapshotUrl: fake.snapshotUrl, pricesUrl: fake.pricesUrl, pollMs: 100 });
  try {
    await fd.start();
    await waitFor(() => metrics.fd.polls >= 2);
    fake.state.mode = '429';
    await waitFor(() => metrics.fd.rateLimited >= 1);
    assert.ok(fd.pollMs >= 1000, `backed off to ${fd.pollMs} ms`);
    assert.equal(store.sources.fanduel.state, 'down');
    assert.match(store.sources.fanduel.lastError, /429/);
    const pollsDuringBackoff = metrics.fd.polls; await sleep(600);
    assert.ok(metrics.fd.polls - pollsDuringBackoff <= 1, 'does not hammer while rate-limited');
    fake.state.mode = 'ok';
    await waitFor(() => store.sources.fanduel.state === 'polling', 4000);
    assert.equal(store.sources.fanduel.lastError, null);
  } finally { fd.stop(); fake.close(); }
});

test('FanDuel endpoints: Ontario uses the .ca site with region ON; US states share the .com API', async () => {
  const { fanduelEndpoints } = await import('../src/sources/fanduel.js');
  const on = fanduelEndpoints('ON');
  assert.equal(on.label, 'Ontario');
  assert.match(on.snapshot, /^https:\/\/sbapi\.on\.sportsbook\.fanduel\.ca\//);
  assert.match(on.prices, /^https:\/\/smp\.on\.sportsbook\.fanduel\.ca\//);
  const nj = fanduelEndpoints('nj');
  assert.match(nj.prices, /^https:\/\/smp\.nj\.sportsbook\.fanduel\.com\//);
  const { store, fd } = source({ region: 'ON' });
  assert.equal(fd.headers()['x-sportsbook-region'], 'ON');
  assert.equal(fd.headers().referer, 'https://on.sportsbook.fanduel.ca/');
  assert.match(fd.snapshotUrl, /timezone=America%2FToronto/);
});

test('interleave: an edge answer applies, but a late answer older than what the board shows is ignored', () => {
  const { store, metrics, fd } = source();
  fd.applySnapshot(SNAP, 1000);
  const p = (odds) => { const x = structuredClone(PRICES.filter((m) => m.marketId === '734.192676407')); x[0].runnerDetails[0].winRunnerOdds.americanDisplayOdds.americanOdds = odds; return x; };
  const key = 'BAL@BUF:2026-11-01|moneyline|away|fanduel';
  fd.applyPrices(p(150), 10_000, 10_000);                      // our poll that started at t=10.0 s
  assert.equal(fd.applyEdgePrices(p(155), 10_500, 10_530), 1); // edge poll started at 10.5 s → newer → applied
  assert.equal(store.quotes.get(key).odds, 155);
  assert.equal(fd.applyEdgePrices(p(148), 10_200, 10_600), 0); // a slow edge answer from 10.2 s arrives late → ignored
  assert.equal(store.quotes.get(key).odds, 155);
  assert.equal(metrics.fd.edgeStale, 1);
  assert.equal(fd.applyPrices(p(160), 11_020, 11_000), 1);     // our next poll (11.0 s) applies normally
  assert.equal(store.sources.fanduel.interleave, true);
});
