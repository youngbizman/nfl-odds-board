// How long does OUR code take per update? (answers "would Go make it faster?")
// Measures the in-process work for one real DraftKings frame and one real FanDuel poll response.
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { BoardStore } from '../src/store.js';
import { Metrics } from '../src/metrics.js';
import { DraftKingsSource } from '../src/sources/draftkings.js';
import { FanDuelSource } from '../src/sources/fanduel.js';

const fx = (n) => JSON.parse(fs.readFileSync(`test/fixtures/${n}`, 'utf8'));
const N = 20_000;
function bench(label, setup, run) {
  const ctx = setup(); for (let i = 0; i < 2000; i++) run(ctx, i); // warm up
  const t = performance.now(); for (let i = 0; i < N; i++) run(ctx, i);
  const us = ((performance.now() - t) / N) * 1000;
  console.log(`${label.padEnd(58)} ${us.toFixed(1).padStart(7)} µs per update`);
}
// DK: parse + apply one JSON socket frame (1 price change; alternate the price so every run is a real change)
const frame = Buffer.from(JSON.stringify({ event: 'update', data: { data: { add: {}, remove: {}, change: { selections: [{ id: '0ML84695689_1', displayOdds: { american: '\u2212499' } }] } }, metadata: { publishedTime: '2026-10-28T23:23:14.248Z' } } }));
bench('DraftKings: parse + apply one socket frame (1 price)', () => {
  const store = new BoardStore(); const dk = new DraftKingsSource(store, new Metrics(), () => {}); dk.applySnapshot(fx('dk-snapshot.json')); return { store, dk };
}, ({ store, dk }, i) => { store.quotes.get('IND@JAX:2026-11-01|moneyline|home|draftkings').odds = i % 2 ? -498 : -500; dk.onMessage(frame); });
// FD: parse JSON + apply a full 9-market response
const pricesText = JSON.stringify(fx('fd-prices.json'));
bench('FanDuel: parse + apply one poll response (9 markets)', () => {
  const store = new BoardStore(); const fd = new FanDuelSource(store, new Metrics(), () => {}); fd.applySnapshot(fx('fd-snapshot.json')); return { store, fd };
}, ({ fd }) => { fd.applyPrices(JSON.parse(pricesText)); });
// SSE serialisation of one typical batch
const store = new BoardStore(); const fd = new FanDuelSource(store, new Metrics(), () => {}); fd.applySnapshot(fx('fd-snapshot.json'));
const q = [...store.quotes.values()][0];
bench('Server: serialise one SSE batch (1 price)', () => null, () => `event: batch\ndata: ${JSON.stringify({ serverTs: Date.now(), quotes: [q], games: [], sources: {} })}\n\n`);
console.log(`(FanDuel full board is 87 markets ≈ 10× the 9-market fixture; Node ${process.version})`);
