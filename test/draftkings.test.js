import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { encode, decode } from '@msgpack/msgpack';
import { DraftKingsSource, familyOf, lineFromId } from '../src/sources/draftkings.js';
import { fixture, fresh, quiet, waitFor, quotesOf } from './helpers.js';

const SNAP = fixture('dk-snapshot.json');
const FRAMES = fixture('dk-frames.json').map((b) => Buffer.from(b, 'base64')); // real frames recorded from DK's WebSocket
const JAX = 'IND@JAX:2026-11-01';

function source(opts = {}) {
  const { store, metrics } = fresh();
  return { store, metrics, dk: new DraftKingsSource(store, metrics, quiet, { candidates: [{ site: 'CA-ON-SB', siteName: 'dkcaon', wsHost: 'x' }], ...opts }) };
}

test('selection ids: family survives a line move, and the line is read from the id', () => {
  assert.equal(familyOf('0HC84695615P350_3'), 'HC84695615_3');
  assert.equal(familyOf('0HC84695615N400_3'), 'HC84695615_3');
  assert.equal(familyOf('0ML84695615_1'), 'ML84695615_1');
  assert.equal(familyOf('0OU84695615O4750_1'), 'OU84695615_1');
  assert.equal(familyOf('something-else'), null);
  assert.equal(lineFromId('0HC84695615P350_3'), 3.5);
  assert.equal(lineFromId('0HC84695689N1000_1'), -10);
  assert.equal(lineFromId('0HC84695689P0_1'), 0);
  assert.equal(lineFromId('0OU84695615O4750_1'), 47.5);
  assert.equal(lineFromId('0ML84695615_1'), null);
});

test('snapshot: every game gets all six DraftKings prices with the right sides and lines', () => {
  const { store, dk } = source();
  dk.applySnapshot(SNAP, 1000);
  assert.equal(store.games.size, 3);
  for (const g of store.games.values()) {
    const qs = quotesOf(store, 'draftkings').filter((q) => q.gameKey === g.key);
    assert.equal(qs.length, 6, g.key);
    const get = (m, s) => qs.find((q) => q.market === m && q.side === s);
    assert.equal(get('spread', 'home').line, -get('spread', 'away').line, 'spread lines mirror');
    assert.equal(get('total', 'over').line, get('total', 'under').line, 'one total number');
    assert.equal(get('moneyline', 'home').line, null);
    for (const q of qs) assert.ok(Number.isInteger(q.odds), `${q.id} odds ${q.odds}`);
  }
  assert.equal(store.quotes.get(`${JAX}|spread|home|draftkings`).line, -10);
});

test('recorded WebSocket frames update the board and carry DraftKings publish time', () => {
  const { store, metrics, dk } = source();
  const snap = structuredClone(SNAP);
  snap.selections.find((s) => s.id === '0ML84695689_1').displayOdds.american = '−480'; // make the recorded frame a real change
  dk.applySnapshot(snap, 1000);
  let applied = 0;
  for (const f of FRAMES) applied += dk.onMessage(f, Date.parse('2026-10-28T19:37:32Z'));
  const jax = store.quotes.get(`${JAX}|moneyline|home|draftkings`);
  assert.equal(jax.odds, -500); assert.equal(jax.prevOdds, -480);
  assert.equal(jax.sourceTs, Date.parse('2026-10-28T19:37:31.728Z'));
  assert.equal(applied, 1);
  assert.equal(metrics.dk.ingestLagPregame.stats().count, 1);
  dk.stop();
});

test('a DraftKings line move (new selection id) is applied instantly, without waiting for a snapshot', () => {
  const { store, metrics, dk } = source();
  dk.applySnapshot(SNAP, 1000);
  // Take a real recorded frame and swap in the JAX spread moving from −10 to −10.5 at −110.
  const msg = decode(FRAMES[1]);
  const swap = (node) => { if (!Array.isArray(node)) return false; if (node[0] === '0ML84695689_1') { node[0] = '0HC84695689N1050_1'; node[1] = 'JAX Jaguars'; node[2][0] = '−110'; node[4] = -10.5; return true; } return node.some(swap); };
  assert.ok(swap(msg));
  assert.equal(dk.onMessage(Buffer.from(encode(msg)), 5000), 1);
  const q = store.quotes.get(`${JAX}|spread|home|draftkings`);
  assert.equal(q.line, -10.5); assert.equal(q.prevLine, -10); assert.equal(q.odds, -110);
  assert.equal(metrics.dk.lineMovesMapped, 1);
  dk.stop();
});

test('garbage on the socket is counted and ignored, never thrown', () => {
  const { metrics, dk } = source();
  assert.equal(dk.onMessage(Buffer.from('not msgpack at all \x00\xff')), 0);
  assert.equal(dk.onMessage(Buffer.from(encode(['id', 'subscribed', null]))), 0);
  assert.ok(metrics.dk.decodeMisses + metrics.dk.wsMessages >= 2);
});

// ---------- against a fake DraftKings (HTTP snapshot + WebSocket) ----------
async function fakeDraftKings({ allowSite = 'CA-ON-SB' } = {}) {
  const subs = [];
  const httpServer = http.createServer((req, res) => {
    const site = /\/sites\/([^/]+)\//.exec(req.url)?.[1];
    if (site !== allowSite) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<H1>Access Denied</H1>'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(SNAP));
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => ws.on('message', (d) => { const m = decode(d); subs.push(m); ws.send(encode([m.id, 'subscribed', null, null, [0, 0]])); }));
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;
  return { port, subs, wss, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/websocket`, close: () => { for (const c of wss.clients) c.terminate(); wss.close(); httpServer.close(); } };
}

test('picks the regional site that answers, subscribes, and reconnects + re-snapshots when the socket drops', async () => {
  const fake = await fakeDraftKings({ allowSite: 'CA-ON-SB' });
  const { store, metrics, dk } = source({ candidates: ['US-OH-SB', 'CA-ON-SB'].map((site) => ({ site, siteName: site === 'CA-ON-SB' ? 'dkcaon' : 'dkusoh', wsHost: 'x' })), nashBase: fake.base, wsUrl: fake.ws });
  try {
    await dk.start();
    assert.equal(dk.site, 'CA-ON-SB', 'skips the region that returned 403');
    await waitFor(() => fake.subs.length === 1);
    assert.equal(fake.subs[0].method, 'subscribe'); assert.equal(fake.subs[0].params.siteName, 'dkcaon'); assert.equal(fake.subs[0].params.jwt, 'default-token');
    assert.equal(quotesOf(store, 'draftkings').length, 18);
    // a recorded frame pushed by the server reaches the store
    store.upsertQuote({ gameKey: JAX, market: 'moneyline', side: 'home', book: 'draftkings', line: null, odds: -480 });
    for (const c of fake.wss.clients) for (const f of FRAMES) c.send(f);
    await waitFor(() => store.quotes.get(`${JAX}|moneyline|home|draftkings`).odds === -500);
    // drop the connection: DK goes down, then comes back on its own and subscribes again
    for (const c of fake.wss.clients) c.terminate();
    await waitFor(() => store.sources.draftkings.state === 'down');
    await waitFor(() => fake.subs.length === 2 && store.sources.draftkings.state === 'live', 5000);
    assert.equal(metrics.dk.reconnects, 1);
    assert.ok(metrics.dk.snapshots >= 2, 're-snapshot after reconnect');
  } finally { dk.stop(); fake.close(); }
});

test('when every region refuses this IP, DraftKings is marked down and waits for the edge relay', async () => {
  const fake = await fakeDraftKings({ allowSite: 'nowhere' });
  const { store, dk } = source({ candidates: ['US-OH-SB', 'US-NJ-SB'].map((site) => ({ site, siteName: 'x', wsHost: 'x' })), nashBase: fake.base, wsUrl: fake.ws });
  try {
    await dk.start();
    assert.equal(store.sources.draftkings.state, 'down');
    assert.match(store.sources.draftkings.mode, /edge/);
    assert.equal(fake.subs.length, 0, 'no WebSocket opened without a snapshot');
  } finally { dk.stop(); fake.close(); }
});
