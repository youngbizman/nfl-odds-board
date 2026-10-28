import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DraftKingsSource, familyOf, lineFromId, regionLabel } from '../src/sources/draftkings.js';
import { fixture, fresh, quiet, waitFor, quotesOf } from './helpers.js';

const SNAP = fixture('dk-snapshot.json');
const REAL_FRAMES = fixture('dk-json-frames.json'); // real JSON frames recorded from DK's socket (other games)
const JAX = 'IND@JAX:2026-11-01';
const sel = (id) => SNAP.selections.find((s) => s.id === id);

/** Build a frame in DK's real JSON shape. */
const frame = ({ add = {}, change = {}, remove = {} }, publishedTime = '2026-10-28T23:23:14.248Z') => Buffer.from(JSON.stringify({
  id: 'sub', event: 'update', websocketPublishTimestamp: publishedTime,
  data: { data: { add: { events: [], markets: [], selections: [], leagues: [], sports: [], ...add }, remove: { events: [], markets: [], selections: [], ...remove }, change: { events: [], markets: [], selections: [], ...change } },
    metadata: { createdTime: publishedTime, receivedTime: publishedTime, publishedTime } } }));

function source(opts = {}) {
  const { store, metrics } = fresh();
  return { store, metrics, dk: new DraftKingsSource(store, metrics, quiet, { candidates: [{ site: 'CA-ON-SB', siteName: 'dkcaon', wsHost: 'x' }], ...opts }) };
}

test('selection ids: family survives a line move, line is read from the id, region label from the site', () => {
  assert.equal(familyOf('0HC84695615P350_3'), 'HC84695615_3');
  assert.equal(familyOf('0HC84695615N400_3'), 'HC84695615_3');
  assert.equal(familyOf('0ML84695615_1'), 'ML84695615_1');
  assert.equal(familyOf('0OU84695615O4750_1'), 'OU84695615_1');
  assert.equal(familyOf('something-else'), null);
  assert.equal(lineFromId('0HC84695615P350_3'), 3.5);
  assert.equal(lineFromId('0HC84695689N1000_1'), -10);
  assert.equal(lineFromId('0OU84695615O4750_1'), 47.5);
  assert.equal(lineFromId('0ML84695615_1'), null);
  assert.equal(regionLabel('CA-ON-SB'), 'Ontario'); assert.equal(regionLabel('US-NJ-SB'), 'NJ');
});

test('snapshot: every game gets all six DraftKings prices with the right sides and lines', () => {
  const { store, dk } = source();
  assert.deepEqual(dk.applySnapshot(SNAP, 1000), { games: 3, selections: 18 });
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
  assert.equal(store.sources.draftkings.lastSnapshotAt, 1000);
});

test('a `change` frame updates the price and records DraftKings\' publish time as the source timestamp', () => {
  const { store, metrics, dk } = source();
  dk.applySnapshot(SNAP, 1000);
  const f = frame({ change: { selections: [{ id: '0ML84695689_1', label: 'JAX Jaguars', displayOdds: { american: '−480' }, trueOdds: 1.2 }] } });
  assert.equal(dk.onMessage(f, Date.parse('2026-10-28T23:23:14.330Z')), 1);
  const q = store.quotes.get(`${JAX}|moneyline|home|draftkings`);
  assert.equal(q.odds, -480); assert.equal(q.prevOdds, -500);
  assert.equal(q.sourceTs, Date.parse('2026-10-28T23:23:14.248Z'));
  assert.equal(metrics.dk.ingestLagPregame.stats().p50, 82);
  assert.equal(dk.onMessage(f, 5000), 0, 'the same price again changes nothing');
  dk.stop();
});

test('a line move arrives as remove(old) + add(new id) and is applied instantly with the new line', () => {
  const { store, metrics, dk } = source();
  dk.applySnapshot(SNAP, 1000);
  const old = sel('0HC84695689N1000_1');
  const moved = { ...old, id: '0HC84695689N1050_1', points: -10.5, displayOdds: { ...old.displayOdds, american: '−110' } };
  assert.equal(dk.onMessage(frame({ remove: { selections: ['0HC84695689N1000_1'] }, add: { selections: [moved] } }), 2000), 1);
  const q = store.quotes.get(`${JAX}|spread|home|draftkings`);
  assert.equal(q.line, -10.5); assert.equal(q.prevLine, -10); assert.equal(q.odds, -110);
  assert.ok(dk.selIndex.has('0HC84695689N1050_1')); assert.ok(!dk.selIndex.has('0HC84695689N1000_1'));
  // a later `change` on the NEW id works too, and a change on an id we only know by family still maps
  assert.equal(dk.onMessage(frame({ change: { selections: [{ id: '0HC84695689N1050_1', displayOdds: { american: '−115' } }] } }), 3000), 1);
  assert.equal(store.quotes.get(`${JAX}|spread|home|draftkings`).odds, -115);
  assert.equal(dk.onMessage(frame({ change: { selections: [{ id: '0HC84695689N1100_1', displayOdds: { american: '−105' }, points: -11 }] } }), 4000), 1);
  assert.equal(store.quotes.get(`${JAX}|spread|home|draftkings`).line, -11);
  assert.equal(metrics.dk.lineMovesMapped, 1);
  dk.stop();
});

test('event status changes flip the game to live; removed markets drop their prices', () => {
  const { store, dk } = source();
  dk.applySnapshot(SNAP, 1000);
  dk.onMessage(frame({ change: { events: [{ id: '34118246', status: 'STARTED' }] } }), 2000);
  assert.equal(store.games.get(JAX).status, 'live');
  const mkt = SNAP.markets.find((m) => m.eventId === '34118246' && m.name === 'Total');
  dk.onMessage(frame({ remove: { markets: [mkt.id] } }), 3000);
  assert.equal(quotesOf(store, 'draftkings').filter((q) => q.gameKey === JAX && q.market === 'total').length, 0);
  assert.equal(quotesOf(store, 'draftkings').filter((q) => q.gameKey === JAX).length, 4);
  dk.stop();
});

test('real recorded frames for games we do not hold are ignored safely and trigger a snapshot request', async () => {
  const asks = [];
  const { metrics, dk } = source({ onNeedSnapshot: (why) => asks.push(why) });
  dk.restBlocked = true;
  dk.applySnapshot(SNAP, 1000);
  let n = 0; for (const f of REAL_FRAMES) n += dk.onMessage(Buffer.from(JSON.stringify(f)), 2000);
  assert.equal(n, 0);
  assert.equal(dk.onMessage(Buffer.from('not json'), 2000), 0);
  assert.ok(metrics.dk.decodeMisses >= 1);
  await waitFor(() => asks.length === 1, 4000);
  assert.match(asks[0], /unknown ids/);
  dk.stop();
});

// ---------- against a fake DraftKings (HTTP snapshot + JSON WebSocket) ----------
async function fakeDraftKings({ allowSite = 'CA-ON-SB' } = {}) {
  const subs = [];
  const httpServer = http.createServer((req, res) => {
    const site = /\/sites\/([^/]+)\//.exec(req.url)?.[1];
    if (site !== allowSite) { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<H1>Access Denied</H1>'); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(SNAP));
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws) => ws.on('message', (d) => { const m = JSON.parse(d); subs.push(m); ws.send(JSON.stringify({ id: m.id, event: 'subscribed', data: '' })); }));
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
    assert.equal(dk.restBlocked, false);
    await waitFor(() => fake.subs.length === 1);
    assert.equal(fake.subs[0].method, 'subscribe'); assert.equal(fake.subs[0].params.siteName, 'dkcaon'); assert.equal(fake.subs[0].params.jwt, 'default-token');
    assert.equal(quotesOf(store, 'draftkings').length, 18);
    for (const c of fake.wss.clients) c.send(frame({ change: { selections: [{ id: '0ML84695689_1', displayOdds: { american: '−480' } }] } }));
    await waitFor(() => store.quotes.get(`${JAX}|moneyline|home|draftkings`).odds === -480);
    for (const c of fake.wss.clients) c.terminate();
    await waitFor(() => store.sources.draftkings.state === 'down');
    await waitFor(() => fake.subs.length === 2 && store.sources.draftkings.state === 'live', 5000);
    assert.equal(metrics.dk.reconnects, 1);
    assert.ok(metrics.dk.snapshots >= 2, 're-snapshot after reconnect');
  } finally { dk.stop(); fake.close(); }
});

test('when the snapshot host refuses this IP, the socket still runs and snapshots are requested from the edge', async () => {
  const fake = await fakeDraftKings({ allowSite: 'nowhere' });
  const asks = [];
  const { store, dk } = source({ candidates: [{ site: 'CA-ON-SB', siteName: 'dkcaon', wsHost: 'x' }], nashBase: fake.base, wsUrl: fake.ws, onNeedSnapshot: (why) => asks.push(why) });
  try {
    await dk.start();
    assert.equal(dk.restBlocked, true);
    assert.equal(store.sources.draftkings.snapshotVia, 'edge');
    await waitFor(() => fake.subs.length === 1 && store.sources.draftkings.state === 'live');
    assert.equal(quotesOf(store, 'draftkings').length, 0, 'no board yet');
    // a snapshot relayed from the edge fills the board; pushes then apply to it
    dk.applySnapshot(SNAP, Date.now(), 'edge');
    assert.equal(quotesOf(store, 'draftkings').length, 18);
    for (const c of fake.wss.clients) c.send(frame({ change: { selections: [{ id: '0ML84695689_3', displayOdds: { american: '+390' } }] } }));
    await waitFor(() => store.quotes.get(`${JAX}|moneyline|away|draftkings`).odds === 390);
    for (const c of fake.wss.clients) c.terminate();
    await waitFor(() => asks.some((w) => w === 'reconnect'), 5000);
  } finally { dk.stop(); fake.close(); }
});

test('clock: the subscribe ack gives DraftKings\' clock offset, and publish times are converted to ours', () => {
  const { store, metrics, dk } = source();
  dk.applySnapshot(SNAP, 1000);
  // DK's clock runs 5 s ahead of ours; round trip 40 ms
  const sentAt = Date.parse('2026-10-28T23:00:00.000Z'); dk.subSentAt = sentAt;
  dk.onMessage(Buffer.from(JSON.stringify({ id: 'x', event: 'subscribed', data: '', websocketPublishTimestamp: '2026-10-28T23:00:05.0200000+00:00' })), sentAt + 40);
  assert.equal(dk.clock.offsetMs, 5000); assert.equal(metrics.dk.clockUncertaintyMs, 20);
  assert.equal(store.sources.draftkings.clockOffsetMs, 5000);
  // DK publishes at 23:00:10.000 on ITS clock = 23:00:05.000 on ours; we receive it 60 ms later
  const recv = Date.parse('2026-10-28T23:00:05.060Z');
  dk.onMessage(frame({ change: { selections: [{ id: '0ML84695689_1', displayOdds: { american: '−470' } }] } }, '2026-10-28T23:00:10.000Z'), recv);
  assert.equal(store.quotes.get(`${JAX}|moneyline|home|draftkings`).sourceTs, Date.parse('2026-10-28T23:00:05.000Z'));
  assert.equal(metrics.dk.ingestLagPregame.stats().p50, 60, 'lag is measured on one clock');
  dk.stop();
});

test('durability: a new process rebuilds the exact DraftKings board from the checkpoint + frame log, no snapshot needed', async () => {
  const { MemoryCheckpoint } = await import('../src/checkpoint.js');
  const cp = new MemoryCheckpoint();
  const a = source({ checkpoint: cp });
  a.dk.applySnapshot(SNAP, 1000);                    // checkpoint saved here
  await new Promise((r) => setImmediate(r));
  const old = sel('0HC84695689N1000_1');
  a.dk.onMessage(frame({ change: { selections: [{ id: '0ML84695689_1', displayOdds: { american: '−470' } }] } }), 2000);
  a.dk.onMessage(frame({ remove: { selections: [old.id] }, add: { selections: [{ ...old, id: '0HC84695689N1050_1', points: -10.5 }] } }), 3000);
  a.dk.onMessage(frame({ change: { events: [{ id: '34118246', status: 'STARTED' }] } }), 4000);
  await new Promise((r) => setImmediate(r));
  assert.equal(cp.frames.length, 3, 'every frame since the checkpoint is logged');
  a.dk.stop();

  const b = source({ checkpoint: cp, candidates: [{ site: 'CA-ON-SB', siteName: 'dkcaon', wsHost: 'x' }] });
  await b.dk.restore();
  const view = (st) => [...st.quotes.values()].filter((q) => q.book === 'draftkings').map((q) => `${q.id}=${q.line}/${q.odds}`).sort();
  assert.deepEqual(view(b.store), view(a.store));
  assert.equal(b.store.quotes.get(`${JAX}|spread|home|draftkings`).line, -10.5);
  assert.equal(b.store.games.get(JAX).status, 'live');
  assert.equal(b.store.sources.draftkings.snapshotVia, 'checkpoint');
  // and it keeps working: a later change on the moved line applies
  assert.equal(b.dk.onMessage(frame({ change: { selections: [{ id: '0HC84695689N1050_1', displayOdds: { american: '−102' } }] } }), 5000), 1);
  assert.equal(b.dk.seq, 4, 'sequence continues after the restored frames');
  b.dk.stop();
});
