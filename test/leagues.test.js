// Other leagues: college football (NCAAF) and the CFL from the same two books, matched across books, kept apart from
// the NFL board, and sent only to viewers who look at that league.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DraftKingsSource } from '../src/sources/draftkings.js';
import { FanDuelSource } from '../src/sources/fanduel.js';
import { LEAGUES, resolveCollegeTeam, resolveCflTeam, leagueOf, leagueGameKey, enabledLeagues } from '../src/leagues.js';
import { makeHttp } from '../src/transport/http.js';
import { fixture, fresh, quiet, waitFor, quotesOf } from './helpers.js';

const DK_NFL = fixture('dk-snapshot.json'), DK_NCAAF = fixture('dk-ncaaf.json'), DK_CFL = fixture('dk-cfl.json');
const FD_NFL = fixture('fd-snapshot.json'), FD_NCAAF = fixture('fd-ncaaf.json'), FD_CFL = fixture('fd-cfl.json');
const ALL = [LEAGUES.nfl, LEAGUES.ncaaf, LEAGUES.cfl];

test('team matching: school-name aliases, CFL nicknames, and NFL keys unchanged', () => {
  for (const [a, b] of [['Miami FL', 'Miami Florida'], ['UConn', 'Connecticut'], ['ULM', 'UL Monroe'], ['San José State', 'San Jose State'], ['Ole Miss', 'Mississippi']]) {
    assert.equal(resolveCollegeTeam(a).key, resolveCollegeTeam(b).key, `${a} = ${b}`);
  }
  assert.notEqual(resolveCollegeTeam('Miami Ohio').key, resolveCollegeTeam('Miami Florida').key);
  assert.equal(resolveCollegeTeam('Texas A&M').key, 'texas-aandm');
  assert.equal(resolveCflTeam('SSK Roughriders').abbr, 'SSK'); assert.equal(resolveCflTeam('Saskatchewan Roughriders').abbr, 'SSK');
  assert.equal(resolveCflTeam('HAM Tiger-Cats').abbr, 'HAM'); assert.equal(resolveCflTeam('British Columbia Lions').abbr, 'BC');
  assert.equal(resolveCflTeam('Detroit Lions')?.abbr, 'BC', 'CFL resolver is only used for CFL events');
  const nfl = LEAGUES.nfl.resolve('GB Packers');
  assert.equal(leagueGameKey('nfl', LEAGUES.nfl.resolve('Carolina Panthers'), nfl, '2026-10-30T00:15:00Z'), 'CAR@GB:2026-10-29', 'NFL keys keep their original form');
  assert.equal(leagueOf('CAR@GB:2026-10-29'), 'nfl'); assert.equal(leagueOf('ncaaf:troy@james-madison:2026-10-29'), 'ncaaf');
  assert.deepEqual(enabledLeagues('ncaaf').map((l) => l.id), ['nfl', 'ncaaf'], 'NFL is always on');
});

test('DraftKings: each league keeps its own board; a new NFL snapshot never removes college or CFL prices', () => {
  const { store, metrics } = fresh();
  const dk = new DraftKingsSource(store, metrics, quiet, { leagues: ALL, http: makeHttp({ mode: 'native' }), candidates: [{ site: 'CA-ON-SB', siteName: 'dkcaon', wsHost: 'x' }] });
  dk.applySnapshot(DK_NFL, 1000, 'direct', 'nfl');
  assert.deepEqual(dk.applySnapshot(DK_NCAAF, 1000, 'direct', 'ncaaf'), { games: 3, selections: 18 });
  assert.deepEqual(dk.applySnapshot(DK_CFL, 1000, 'direct', 'cfl'), { games: 2, selections: 12 });
  const byLeague = (lg) => quotesOf(store, 'draftkings').filter((q) => leagueOf(q.gameKey) === lg).length;
  assert.deepEqual([byLeague('nfl'), byLeague('ncaaf'), byLeague('cfl')], [18, 18, 12]);
  assert.ok(store.games.has('ncaaf:connecticut@air-force:2026-10-31'), [...store.games.keys()].join(' '));
  assert.ok(store.games.has('cfl:WPG@TOR:2026-10-31'), [...store.games.keys()].join(' '));
  assert.equal(store.games.get('ncaaf:connecticut@air-force:2026-10-31').league, 'ncaaf');
  dk.applySnapshot({ ...DK_NFL, selections: DK_NFL.selections.slice(0, 12) }, 2000, 'direct', 'nfl'); // one NFL game's markets gone
  assert.deepEqual([byLeague('nfl'), byLeague('ncaaf'), byLeague('cfl')], [12, 18, 12], 'only NFL prices were removed');
  dk.stop();
});

test('FanDuel: the same college and CFL games land on the same keys as DraftKings; FanDuel-only games are kept; season-wins markets ignored', () => {
  const { store, metrics } = fresh();
  const dk = new DraftKingsSource(store, metrics, quiet, { leagues: ALL, http: makeHttp({ mode: 'native' }), candidates: [{ site: 'CA-ON-SB', siteName: 'dkcaon', wsHost: 'x' }] });
  const fd = new FanDuelSource(store, metrics, quiet, { leagues: ALL, push: false });
  dk.applySnapshot(DK_NCAAF, 1000, 'direct', 'ncaaf'); dk.applySnapshot(DK_CFL, 1000, 'direct', 'cfl');
  assert.deepEqual(fd.applySnapshot(FD_NCAAF, 1000, 'ncaaf'), { games: 4, markets: 12 });
  fd.applySnapshot(FD_CFL, 1000, 'cfl');
  const both = [...store.games.values()].filter((g) => g.books.draftkings && g.books.fanduel).map((g) => g.key).sort();
  assert.deepEqual(both, ['cfl:SSK@BC:2026-10-31', 'cfl:WPG@TOR:2026-10-31', 'ncaaf:connecticut@air-force:2026-10-31', 'ncaaf:miami-florida@north-carolina:2026-10-31', 'ncaaf:troy@james-madison:2026-10-29'].sort());
  const fcs = [...store.games.values()].filter((g) => !g.books.draftkings);
  assert.equal(fcs.length, 1, 'the FanDuel-only small-school game is on the board, priced by one book');
  for (const k of both) for (const b of ['draftkings', 'fanduel']) assert.equal(quotesOf(store, b).filter((q) => q.gameKey === k).length, 6, `${k} ${b}`);
  assert.equal(fd.primaryIds.length, 0, 'no NFL page loaded here'); assert.equal(fd.marketIds.length, 12 + 6);
  dk.stop();
});

test('FanDuel polling: NFL every beat, the other leagues one chunk per beat in turn', async () => {
  const pages = { nfl: FD_NFL, ncaaf: FD_NCAAF, cfl: FD_CFL }; const bodies = [];
  const srv = http.createServer((req, res) => {
    const page = new URL(req.url, 'http://x').searchParams.get('customPageId');
    if (page) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(pages[page])); }
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { bodies.push(JSON.parse(b).marketIds); res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const { store, metrics } = fresh();
  const fd = new FanDuelSource(store, metrics, quiet, { leagues: ALL, push: false, snapshotBase: `${base}/page`, pricesUrl: `${base}/prices`, pollMs: 60, chunkSize: 5 });
  try {
    await fd.start();
    await waitFor(() => metrics.fd.polls >= 6, 3000);
    const nfl = new Set(fd.primaryIds);
    assert.equal(fd.primaryIds.length, 9); assert.equal(fd.otherChunks.length, 4, '18 college + CFL markets in chunks of 5');
    for (const beat of [0, 1, 2]) { // each beat: the two NFL chunks + one other-league chunk
      const sent = bodies.slice(beat * 3, beat * 3 + 3);
      assert.equal(sent.filter((ids) => ids.every((id) => nfl.has(id))).length, 2, `beat ${beat}`);
    }
    const others = bodies.filter((ids) => !ids.some((id) => nfl.has(id)));
    assert.ok(new Set(others.map((x) => x.join())).size >= 3, 'the other-league chunks take turns');
    assert.equal(store.sources.fanduel.state, 'polling');
  } finally { fd.stop(); srv.close(); }
});

test('DraftKings start-up: one snapshot per league (in parallel) and one socket subscription per league', async () => {
  const byLeague = { 88808: DK_NFL, 87637: DK_NCAAF, 33567: DK_CFL }; const asked = [];
  const srv = http.createServer((req, res) => { const id = new URL(req.url, 'http://x').searchParams.get('templateVars'); asked.push(id); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(byLeague[id])); });
  const wss = new WebSocketServer({ server: srv }); const subs = [];
  wss.on('connection', (ws) => ws.on('message', (d) => subs.push(JSON.parse(d))));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port; const { store, metrics } = fresh();
  const dk = new DraftKingsSource(store, metrics, quiet, { leagues: ALL, http: makeHttp({ mode: 'native' }), nashBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/websocket`, candidates: [{ site: 'CA-ON-SB', siteName: 'dkcaon', wsHost: 'x' }] });
  try {
    await dk.start();
    assert.deepEqual(asked.sort(), ['33567', '87637', '88808']);
    await waitFor(() => subs.length === 3);
    assert.deepEqual(subs.map((m) => /leagueId eq '(\d+)'/.exec(m.params.queryParams.query)[1]).sort(), ['33567', '87637', '88808']);
    assert.equal(quotesOf(store, 'draftkings').length, 18 + 18 + 12);
    assert.match(store.sources.draftkings.detail, /8 games, 48 prices \(NFL \+ College \+ CFL\)/);
  } finally { dk.stop(); for (const c of wss.clients) c.terminate(); wss.close(); srv.close(); }
});

test('FanDuel polling: a live college game is polled every beat, like the NFL; FanDuel changes are counted per channel and league', async () => {
  const pages = { nfl: FD_NFL, ncaaf: FD_NCAAF, cfl: FD_CFL }; const bodies = [];
  const srv = http.createServer((req, res) => {
    const page = new URL(req.url, 'http://x').searchParams.get('customPageId');
    if (page) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(pages[page])); }
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { bodies.push({ at: Date.now(), ids: JSON.parse(b).marketIds }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const { store, metrics } = fresh();
  const fd = new FanDuelSource(store, metrics, quiet, { leagues: ALL, push: false, snapshotBase: `${base}/page`, pricesUrl: `${base}/prices`, pollMs: 60, chunkSize: 5 });
  try {
    await fd.start();
    const g = store.games.get('ncaaf:troy@james-madison:2026-10-29');
    const liveIds = [...fd.marketIndex].filter(([, mi]) => mi.gameKey === g.key).map(([id]) => id);
    assert.equal(liveIds.length, 3);
    store.upsertGame({ key: g.key, books: { fanduel: { ...g.books.fanduel, live: true } } });
    const from = Date.now(); await waitFor(() => metrics.fd.polls >= 8, 3000);
    const after = bodies.filter((b) => b.at > from + 70).map((b) => b.ids);
    const beats = Math.floor(after.length / 4);
    assert.ok(beats >= 3, `beats ${beats}`);
    const polledLive = after.filter((ids) => liveIds.every((id) => ids.includes(id))).length;
    assert.ok(polledLive >= beats, `live game's markets polled every beat (${polledLive} of ${beats} beats)`);
    // channel bookkeeping: a poll that moves a price counts as "poll" for its league; a push that moves one, as "push"
    const moved = structuredClone(Object.values(FD_NCAAF.attachments.markets).find((m) => m.marketId === liveIds[0]));
    const md = { marketId: moved.marketId, marketStatus: 'OPEN', runnerDetails: moved.runners.map((r) => ({ selectionId: r.selectionId, handicap: r.handicap, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOdds: 777 } } })) };
    fd.applyPrices([md], Date.now() + 1000, Date.now() + 1000, true);
    fd.applyPush({ ...md, runnerDetails: md.runnerDetails.map((r) => ({ ...r, winRunnerOdds: { americanDisplayOdds: { americanOdds: 555 } } })) }, Date.now() + 2000);
    assert.deepEqual(metrics.fd.byLeague.ncaaf, { push: 2, poll: 2 });
  } finally { fd.stop(); srv.close(); }
});

// ---------- black box: viewers only get the league they look at ----------
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function firstSnapshot(url) {
  const ctrl = new AbortController(); const res = await fetch(url, { signal: ctrl.signal }); const dec = new TextDecoder(); let buf = '', out = null;
  try { for await (const c of res.body) { buf += dec.decode(c, { stream: true }); const m = /event: snapshot\ndata: (.*)\n\n/.exec(buf); if (m) { out = JSON.parse(m[1]); break; } } } catch {}
  ctrl.abort(); return out;
}
test('server: the stream, board and history carry only the league asked for; health counts every league', async () => {
  const pages = { nfl: FD_NFL, ncaaf: FD_NCAAF, cfl: FD_CFL };
  const fdSrv = http.createServer((req, res) => {
    const page = new URL(req.url, 'http://x').searchParams.get('customPageId');
    if (page) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(pages[page])); }
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); });
  });
  await new Promise((r) => fdSrv.listen(0, '127.0.0.1', r));
  const fdBase = `http://127.0.0.1:${fdSrv.address().port}`;
  const port = await freePort(), base = `http://127.0.0.1:${port}`, dead = await freePort();
  const proc = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), SOURCES: 'fanduel', LEAGUES: 'nfl,ncaaf,cfl', EXTRAS: '0', FD_PUSH: '0', KEEPALIVE: '0',
    FD_SNAPSHOT_BASE: `${fdBase}/page`, FD_PRICES_URL: `${fdBase}/prices`, FD_POLL_MS: '200', DK_NASH_BASE: `http://127.0.0.1:${dead}` }, stdio: 'ignore' });
  try {
    await waitFor(async () => { try { return (await (await fetch(`${base}/api/board?league=all`)).json()).games.length === 3 + 4 + 2; } catch { return false; } }, 6000);
    const nfl = await firstSnapshot(`${base}/api/stream`), ncaaf = await firstSnapshot(`${base}/api/stream?league=ncaaf`), cfl = await firstSnapshot(`${base}/api/stream?league=cfl`);
    assert.deepEqual([nfl.games.length, ncaaf.games.length, cfl.games.length], [3, 4, 2]);
    const every = await firstSnapshot(`${base}/api/stream?league=all`); // "All" leagues: one stream with every game
    assert.equal(every.games.length, 3 + 4 + 2); assert.deepEqual(new Set(every.quotes.map((q) => leagueOf(q.gameKey))), new Set(['nfl', 'ncaaf', 'cfl']));
    assert.ok(nfl.games.every((g) => leagueOf(g.key) === 'nfl') && ncaaf.quotes.every((q) => leagueOf(q.gameKey) === 'ncaaf'));
    assert.deepEqual(ncaaf.leagues.map((l) => [l.id, l.games]), [['nfl', 3], ['ncaaf', 4], ['cfl', 2]]);
    assert.equal((await (await fetch(`${base}/api/board`)).json()).games.length, 3, 'no league = NFL, as before');
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.games, 3); assert.equal(h.leagues.ncaaf.quotes.fanduel, 24);
    const hist = await (await fetch(`${base}/api/history?league=cfl`)).json();
    assert.ok(Object.keys(hist.series).length > 0 && Object.keys(hist.series).every((id) => leagueOf(id) === 'cfl'));
    // one game's own page: only that game's prices, up to a week back; an unknown game is a 404
    const gk = cfl.games[0].key;
    const one = await (await fetch(`${base}/api/history?game=${encodeURIComponent(gk)}&hours=168`)).json();
    assert.ok(Object.keys(one.series).length > 0 && Object.keys(one.series).every((id) => id.startsWith(`${gk}|`)));
    assert.equal((await fetch(`${base}/api/history?game=nope`)).status, 404);
  } finally { proc.kill(); fdSrv.close(); }
});
