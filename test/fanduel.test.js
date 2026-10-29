import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FanDuelSource } from '../src/sources/fanduel.js';
import { fixture, fresh, quiet, waitFor, quotesOf, sleep } from './helpers.js';

const SNAP = fixture('fd-snapshot.json');
const PRICES = fixture('fd-prices.json'); // a real getMarketPrices response for the same markets

function source(opts = {}) { const { store, metrics } = fresh(); return { store, metrics, fd: new FanDuelSource(store, metrics, quiet, { push: false, ...opts }) }; }

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

test('polls every market on a fixed beat (one request while under the per-request cap)', async () => {
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

// ---------- chunked polling (FanDuel answers at most 80 markets per request and silently drops the rest) ----------
test('chunk(): the fewest requests of at most N markets, evenly sized', async () => {
  const { chunk } = await import('../src/sources/fanduel.js');
  const ids = Array.from({ length: 87 }, (_, i) => i);
  assert.deepEqual(chunk(ids, 50).map((c) => c.length), [44, 43]);
  assert.deepEqual(chunk(ids.slice(0, 50), 50).map((c) => c.length), [50]);
  assert.deepEqual(chunk([], 50).map((c) => c.length), []);
  assert.deepEqual(chunk(ids, 50).flat(), ids, 'nothing lost, order kept');
});

test('polling splits the markets into parallel requests under the cap, and every market is updated', async () => {
  const CAP = 4; // pretend FanDuel's cap is 4 markets per answer
  const bodies = []; let inFlight = 0, maxInFlight = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/snapshot')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(SNAP)); }
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const ids = JSON.parse(body).marketIds; bodies.push(ids); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => { inFlight--; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(PRICES.filter((m) => ids.includes(m.marketId)).slice(0, CAP))); }, 20);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { store, metrics, fd } = source({ snapshotUrl: `${base}/snapshot`, pricesUrl: `${base}/prices`, pollMs: 100, chunkSize: CAP });
  try {
    await fd.start();
    await waitFor(() => metrics.fd.polls >= 2, 3000);
    assert.deepEqual(bodies.slice(0, 3).map((b) => b.length), [3, 3, 3], '9 markets → 3 requests of 3');
    assert.ok(maxInFlight >= 2, 'the requests run in parallel');
    assert.equal(metrics.fd.marketsMissing, 0, 'no market left out of the answers');
    assert.match(store.sources.fanduel.detail, /9\/9 markets in 3 parallel requests/);
  } finally { fd.stop(); server.close(); }
});

test('a suspended market greys every price in it and keeps the last odds, even if the runners still say ACTIVE', () => {
  const { store, fd } = source();
  fd.applySnapshot(SNAP, 1000);
  const p = structuredClone(PRICES.filter((m) => m.marketId === '734.192676407'));
  p[0].marketStatus = 'SUSPENDED'; for (const r of p[0].runnerDetails) delete r.winRunnerOdds;
  fd.applyPrices(p, 2000);
  const qs = quotesOf(store, 'fanduel').filter((q) => q.market === 'moneyline' && q.gameKey === 'BAL@BUF:2026-11-01');
  assert.equal(qs.length, 2); assert.ok(qs.every((q) => q.suspended && Number.isInteger(q.odds)), JSON.stringify(qs));
});

// ---------- push (AppSync GraphQL over WebSocket) against a fake AppSync ----------
import { WebSocketServer } from 'ws';
import { parsePushConfig, discoverPushConfig, FD_PUSH_QUERY } from '../src/sources/fanduel-push.js';

const BUNDLE = 'x={aws_appsync_graphqlEndpoint:"https://pir.{REGION}.sportsbook.fanduel.ca/graphql",aws_appsync_region:"ca-west-1",'
  + 'aws_appsync_authenticationType:"PIR_AUTH_KEY",aws_appsync_clientId:"public-client-123",aws_appsync_wssEndpoint:"wss://pir.{REGION}.sportsbook.fanduel.ca/graphql/realtime"},y=1';

test('push settings are read from the web app bundle that sw.js names; a changed shape is an error, not a guess', async () => {
  assert.deepEqual(parsePushConfig(BUNDLE, 'ON'), { clientId: 'public-client-123', endpoint: 'https://pir.on.sportsbook.fanduel.ca/graphql', wssUrl: 'wss://pir.on.sportsbook.fanduel.ca/graphql/realtime' });
  assert.throws(() => parsePushConfig(BUNDLE.replace('PIR_AUTH_KEY', 'API_KEY'), 'ON'), /changed shape/);
  assert.throws(() => parsePushConfig('nothing here', 'ON'), /not found/);
  const asked = [];
  const fetchImpl = async (url) => { asked.push(url); return new Response(url.endsWith('/sw.js') ? 'precache(["/static/js/main.ab12cd.js","/x.css"])' : BUNDLE, { status: 200 }); };
  const cfg = await discoverPushConfig({ region: 'ON', fetchImpl });
  assert.deepEqual(asked, ['https://sportsbook.fanduel.ca/sw.js', 'https://sportsbook.fanduel.ca/static/js/main.ab12cd.js']);
  assert.equal(cfg.clientId, 'public-client-123');
});

async function fakeAppSync({ ack = true } = {}) {
  const st = { conns: 0, starts: [], auth: null, origin: null, protocol: null, sockets: new Set() };
  const wss = new WebSocketServer({ port: 0, handleProtocols: (p) => (p.has('graphql-ws') ? 'graphql-ws' : false) });
  wss.on('connection', (ws, req) => {
    st.conns++; st.sockets.add(ws); st.protocol = ws.protocol; st.origin = req.headers.origin;
    const q = new URL(req.url, 'ws://x').searchParams; st.auth = JSON.parse(Buffer.from(q.get('header'), 'base64').toString());
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'connection_init' && ack) ws.send(JSON.stringify({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } }));
      if (m.type === 'start') { const p = JSON.parse(m.payload.data); st.starts.push({ id: m.id, ids: p.variables.ids, query: p.query, ext: m.payload.extensions }); ws.send(JSON.stringify({ type: 'start_ack', id: m.id })); }
    });
    ws.on('close', () => st.sockets.delete(ws));
  });
  await new Promise((r) => wss.once('listening', r));
  const send = (market) => { for (const ws of st.sockets) for (const s of st.starts) if (s.ids.includes(market.marketId)) ws.send(JSON.stringify({ type: 'data', id: s.id, payload: { data: { onUpdateMarketPrice: market } } })); };
  return { st, url: `ws://127.0.0.1:${wss.address().port}/graphql/realtime`, send, kill: () => { for (const ws of st.sockets) ws.terminate(); }, close: () => wss.close() };
}

test('push: subscribes to every game-line market, a pushed price reaches the board at once, an older poll cannot overwrite it', async () => {
  const fake = await fakeAppSync();
  const ff = await fakeFanDuel();
  const config = { clientId: 'public-client-123', endpoint: 'https://pir.on.sportsbook.fanduel.ca/graphql', wssUrl: fake.url };
  const { store, metrics, fd } = source({ push: true, pushOpts: { getConfig: async () => config, url: fake.url, chunk: 4 }, snapshotUrl: ff.snapshotUrl, pricesUrl: ff.pricesUrl, pollMs: 60_000 });
  try {
    await fd.start();
    await waitFor(() => store.sources.fanduel.push === 'live', 3000);
    assert.equal(fake.st.protocol, 'graphql-ws'); assert.equal(fake.st.origin, 'https://sportsbook.fanduel.ca');
    assert.deepEqual(fake.st.auth, { Authorization: 'public-client-123', host: 'pir.on.sportsbook.fanduel.ca' });
    assert.deepEqual(fake.st.starts.map((s) => s.ids.length), [4, 4, 1], '9 markets in subscriptions of at most 4');
    assert.equal(fake.st.starts[0].query, FD_PUSH_QUERY); assert.equal(fake.st.starts[0].ext.authorization.Authorization, 'public-client-123');
    assert.equal(store.sources.fanduel.mode, 'push+poll');
    // FanDuel changes the BAL moneyline
    const m = structuredClone(PRICES.find((x) => x.marketId === '734.192676407'));
    m.runnerDetails[0].winRunnerOdds.americanDisplayOdds.americanOdds = 177; m.updatedAt = new Date(Date.now() - 40).toISOString();
    const pollStartedBefore = Date.now() - 5;
    fake.send(m);
    const key = 'BAL@BUF:2026-11-01|moneyline|away|fanduel';
    await waitFor(() => store.quotes.get(key)?.odds === 177, 2000);
    assert.equal(metrics.fd.pushMarkets, 1); assert.equal(metrics.fd.pushChanges, 1);
    const lag = metrics.fd.pushLag.stats(); assert.ok(lag.count === 1 && lag.p50 >= 30 && lag.p50 < 500, `push lag ${lag.p50}`);
    // a poll that had started before the push landed answers with the old price: ignored
    assert.equal(fd.applyPrices(PRICES, Date.now(), pollStartedBefore), 0);
    assert.equal(store.quotes.get(key).odds, 177);
  } finally { fd.stop(); fake.close(); ff.close(); }
});

test('push: a dropped connection reconnects and re-subscribes by itself; polling keeps the board fresh meanwhile', async () => {
  const fake = await fakeAppSync();
  const ff = await fakeFanDuel();
  const config = { clientId: 'k', endpoint: 'https://pir.on.sportsbook.fanduel.ca/graphql', wssUrl: fake.url };
  const { store, metrics, fd } = source({ push: true, pushOpts: { getConfig: async () => config, url: fake.url }, snapshotUrl: ff.snapshotUrl, pricesUrl: ff.pricesUrl, pollMs: 100 });
  try {
    await fd.start();
    await waitFor(() => store.sources.fanduel.push === 'live', 3000);
    fake.kill();
    await waitFor(() => store.sources.fanduel.push === 'down', 2000);
    const polls = metrics.fd.polls;
    await waitFor(() => store.sources.fanduel.push === 'live' && fake.st.conns === 2, 4000);
    assert.ok(metrics.fd.polls > polls, 'polling carried on while the push was down');
    assert.equal(fake.st.starts.at(-1).ids.length, 9, 're-subscribed to every market');
  } finally { fd.stop(); fake.close(); ff.close(); }
});
