// BetMGM worker: real answers recorded from BetMGM's own API (tools/record-mgm-fixtures.mjs, Nov 9 2026), no browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BetMGMSource, slimFixtures, normalizeFixture, splitName } from '../src/sources/betmgm.js';
import { LEAGUES, leagueGameKey } from '../src/leagues.js';
import { resolveTeam } from '../src/model.js';
import { fixture, fresh, quiet, quotesOf, waitFor } from './helpers.js';

const NFL = fixture('mgm-nfl.json');      // 15 games, v2 shape (optionMarkets)
const NCAAF = fixture('mgm-ncaaf.json');  // 67 games
const CFL = fixture('mgm-cfl.json');      // 1 game, v1 shape (games / results)
const RAW = fixture('mgm-raw-sample.json'); // unslimmed: one NFL (v2), one college (v2), one CFL (v1) fixture
const GAME = 'BUF@MIN:2026-11-09';

function source(opts = {}) { const { store, metrics } = fresh(); return { store, metrics, mgm: new BetMGMSource(store, metrics, quiet, { browser: false, ...opts }) }; }
const q = (store, id) => store.quotes.get(`${GAME}|${id}|betmgm`);
const bufMin = (data) => data.fixtures.find((f) => f.name === 'Buffalo Bills @ Minnesota Vikings');

test('slimming keeps the game lines of both shapes and drops players, props and everything else', () => {
  const s = slimFixtures(RAW);
  assert.equal(s.fixtures.length, 3);
  const [v2] = s.fixtures; const v1 = s.fixtures.find((f) => f.games.length);
  assert.deepEqual(v2.optionMarkets.map((m) => m.name).sort(), ['Moneyline', 'Spread', 'Totals']);
  assert.ok(v2.participants.every((p) => p.type !== 'Player') && v2.participants.length === 2);
  assert.deepEqual(v1.games.map((g) => g.name).sort(), ['Moneyline', 'Spread', 'Totals']);
  assert.ok(JSON.stringify(s).length < JSON.stringify(RAW).length / 5, 'slim is a small fraction of the raw answer');
  // it must be self-contained: the browser runs its source text inside BetMGM's page
  const again = new Function(`return (${slimFixtures.toString()})`)();
  assert.deepEqual(again(RAW), s);
});

test('NFL: every game matched, six prices each, lines and sides right (v2 shape)', () => {
  const { store, mgm } = source();
  const n = mgm.applySnapshot(NFL, 1000, 'nfl');
  assert.equal(n.games, 15); assert.equal(n.prices, 90); assert.equal(n.unmatched, 0);
  for (const g of store.games.values()) assert.equal(quotesOf(store, 'betmgm').filter((x) => x.gameKey === g.key).length, 6, g.key);
  assert.deepEqual([q(store, 'spread|away').line, q(store, 'spread|away').odds], [-3.5, 100]);
  assert.deepEqual([q(store, 'spread|home').line, q(store, 'spread|home').odds], [3.5, -118]);
  assert.deepEqual([q(store, 'total|over').line, q(store, 'total|over').odds, q(store, 'total|under').odds], [45, -108, -110]);
  assert.deepEqual([q(store, 'moneyline|away').odds, q(store, 'moneyline|home').odds, q(store, 'moneyline|home').line], [-185, 150, null]);
});

test('game keys are the same as DraftKings and FanDuel build for the same matchup', () => {
  const { store, mgm } = source();
  mgm.applySnapshot(NFL, 1000, 'nfl');
  const g = store.games.get(GAME);
  const team = (raw) => ({ ...resolveTeam(raw), key: resolveTeam(raw).abbr });
  assert.equal(leagueGameKey('nfl', team('BUF Bills'), team('MIN Vikings'), g.start), GAME); // DraftKings' naming
  assert.equal(leagueGameKey('nfl', team('Buffalo Bills'), team('Minnesota Vikings'), g.start), GAME); // FanDuel's
});

test('college and CFL: every game matched, including the v1 shape and "(Neutral Venue)"', () => {
  const { store, mgm } = source();
  const c = mgm.applySnapshot(NCAAF, 1000, 'ncaaf');
  assert.equal(c.unmatched, 0); assert.equal(c.games, 67); assert.equal(c.prices, 67 * 6);
  assert.ok(store.games.has('ncaaf:duke@miami-florida:2026-11-14') || [...store.games.keys()].some((k) => k.includes('@miami-florida:')), 'Miami (FL) uses the shared alias');
  assert.ok([...store.games.keys()].some((k) => k.includes('@miami-ohio:')), 'Miami (OH) uses the shared alias');
  const f = mgm.applySnapshot(CFL, 1000, 'cfl');
  assert.deepEqual([f.games, f.prices, f.unmatched], [1, 6, 0]);
  const key = [...store.games.keys()].find((k) => k.startsWith('cfl:'));
  assert.match(key, /^cfl:MTL@EDM:/);
  assert.deepEqual(splitName('Montreal Alouettes at Edmonton Elks (Neutral Venue)'), { away: 'Montreal Alouettes', home: 'Edmonton Elks' });
});

test('a hidden price is suspended and keeps its last price; a closed fixture suspends everything', () => {
  const { store, mgm } = source();
  mgm.applySnapshot(NFL, 1000, 'nfl');
  const d = structuredClone(NFL); const ml = bufMin(d).optionMarkets.find((m) => m.name === 'Moneyline');
  ml.options[0].status = 'Hidden'; ml.options[0].americanOdds = null;
  mgm.applySnapshot(d, 2000, 'nfl');
  assert.equal(q(store, 'moneyline|away').suspended, true); assert.equal(q(store, 'moneyline|away').odds, -185);
  assert.equal(q(store, 'moneyline|home').suspended, false);
  bufMin(d).isOpenForBetting = false;
  mgm.applySnapshot(d, 3000, 'nfl');
  assert.ok(['spread|away', 'total|over', 'moneyline|home'].every((id) => q(store, id).suspended));
});

test('a line move is picked up from the option name, with the previous line kept', () => {
  const { store, mgm } = source();
  mgm.applySnapshot(NFL, 1000, 'nfl');
  const d = structuredClone(NFL); const sp = bufMin(d).optionMarkets.find((m) => m.name === 'Spread');
  sp.options[0].name = 'Buffalo Bills -4'; sp.options[0].americanOdds = -105;
  sp.options[1].name = 'Minnesota Vikings +4'; sp.options[1].americanOdds = -115;
  const n = mgm.applySnapshot(d, 2000, 'nfl');
  assert.equal(n.changes, 2);
  assert.deepEqual([q(store, 'spread|away').line, q(store, 'spread|away').prevLine, q(store, 'spread|away').odds], [-4, -3.5, -105]);
  assert.equal(mgm.applySnapshot(d, 3000, 'nfl').changes, 0, 'an unchanged answer changes nothing');
});

test('a market BetMGM stops listing is removed; a game going in-play turns live', () => {
  const { store, mgm } = source();
  mgm.applySnapshot(NFL, 1000, 'nfl');
  const d = structuredClone(NFL); const f = bufMin(d);
  f.optionMarkets = f.optionMarkets.filter((m) => m.name !== 'Totals'); f.stage = 'Live';
  mgm.applySnapshot(d, 2000, 'nfl');
  assert.equal(q(store, 'total|over'), undefined); assert.equal(q(store, 'total|under'), undefined);
  assert.ok(q(store, 'spread|away'));
  assert.equal(store.games.get(GAME).status, 'live');
});

test('polling: ok → live; refused → backs off, asks the edge; edge data only counts while our own session fails', async () => {
  let mode = 'ok'; const asked = [];
  const fetchFixtures = async (id) => { if (mode !== 'ok') { const e = new Error('HTTP 403'); e.status = 403; throw e; } return id === '35' ? NFL : id === '3845' ? CFL : NCAAF; };
  const { store, metrics, mgm } = source({ fetchFixtures, pollMs: 50, ownFreshMs: 300, onNeedEdge: (on) => asked.push(on) });
  await mgm.start();
  try {
    await waitFor(() => store.sources.betmgm.state === 'polling' && store.sources.betmgm.via === 'browser');
    assert.equal(quotesOf(store, 'betmgm').filter((x) => !/^(ncaaf|cfl):/.test(x.gameKey)).length, 90);
    // while our own session answers, the edge is not needed and its data is ignored
    assert.ok(mgm.applyEdge('nfl', NFL).ignored); assert.equal(metrics.mgm.edgeIgnored, 1);
    mode = 'refused';
    await waitFor(() => metrics.mgm.rateLimited >= 2);
    assert.ok(mgm.pollMs >= 100, `backed off to ${mgm.pollMs} ms`);
    await waitFor(() => asked.includes(true), 2000);
    const r = mgm.applyEdge('nfl', NFL, Date.now());
    assert.equal(r.games, 15); assert.equal(store.sources.betmgm.via, 'edge'); assert.equal(metrics.mgm.edgeApplied, 1);
    mode = 'ok';
    await waitFor(() => asked[asked.length - 1] === false && store.sources.betmgm.via === 'browser', 5000);
  } finally { mgm.stop(); }
});

test('without a browser the worker waits for the edge instead of failing', async () => {
  const asked = [];
  const { store, mgm } = source({ onNeedEdge: (on, why) => asked.push([on, why]) });
  await mgm.start();
  assert.deepEqual(asked, [[true, 'no browser on this server']]);
  assert.equal(store.sources.betmgm.state, 'down');
  mgm.applyEdge('cfl', CFL);
  assert.equal(store.sources.betmgm.state, 'polling'); assert.equal(store.sources.betmgm.via, 'edge');
  assert.equal(quotesOf(store, 'betmgm').length, 6);
  mgm.stop();
});

test('normalizeFixture: a game whose teams do not match the league is skipped, not guessed', () => {
  const f = structuredClone(bufMin(NFL)); f.participants[0].name = 'Somewhere Unknowns'; f.participants[1].name = 'Nowhere Nobodies';
  assert.equal(normalizeFixture(f, LEAGUES.nfl), null);
});

test('an empty answer once keeps the prices (could be a glitch); twice in a row takes the league down', () => {
  const { store, mgm } = source();
  mgm.applySnapshot(NFL, 1000, 'nfl');
  mgm.applySnapshot(CFL, 1000, 'cfl');
  mgm.applySnapshot({ fixtures: [] }, 2000, 'nfl');
  assert.equal(quotesOf(store, 'betmgm').filter((x) => !x.gameKey.startsWith('cfl:')).length, 90, 'one empty answer is not trusted');
  mgm.applySnapshot({ fixtures: [] }, 4000, 'nfl');
  assert.equal(quotesOf(store, 'betmgm').filter((x) => !x.gameKey.startsWith('cfl:')).length, 0, 'two in a row: nothing up, nothing shown');
  assert.equal(quotesOf(store, 'betmgm').filter((x) => x.gameKey.startsWith('cfl:')).length, 6, 'other leagues untouched');
  mgm.applySnapshot(NFL, 5000, 'nfl'); mgm.applySnapshot({ fixtures: [] }, 6000, 'nfl');
  assert.equal(quotesOf(store, 'betmgm').filter((x) => !x.gameKey.startsWith('cfl:')).length, 90, 'a real answer resets the count');
});

test('an answer without a fixtures list is a failure, never "no games"', async () => {
  const { store, metrics, mgm } = source({ fetchFixtures: async () => ({ error: 'changed format' }), pollMs: 30 });
  mgm.applySnapshot(NFL, Date.now(), 'nfl');
  await mgm.start();
  try {
    await waitFor(() => metrics.mgm.pollErrors >= 1);
    assert.equal(quotesOf(store, 'betmgm').length, 90, 'prices are not wiped by a broken answer');
    assert.equal(store.sources.betmgm.state, 'down');
    assert.ok(mgm.applyEdge('nfl', { nope: 1 }).error, 'the edge cannot send one either');
  } finally { mgm.stop(); }
});

test('one healthy league does not keep another league\'s old prices fresh', async () => {
  let cflOk = true;
  const fetchFixtures = async (id) => { if (id === '3845' && !cflOk) throw new Error('HTTP 500'); return id === '35' ? NFL : id === '3845' ? CFL : NCAAF; };
  const { store, mgm } = source({ fetchFixtures, pollMs: 20, staleMs: 250 });
  await mgm.start();
  try {
    await waitFor(() => quotesOf(store, 'betmgm').some((x) => x.gameKey.startsWith('cfl:')));
    assert.deepEqual(store.sources.betmgm.staleLeagues, []);
    cflOk = false;
    await waitFor(() => store.sources.betmgm.staleLeagues?.includes('cfl'), 3000);
    assert.ok(!store.sources.betmgm.staleLeagues.includes('nfl'), 'the NFL keeps answering');
    cflOk = true;
    await waitFor(() => !store.sources.betmgm.staleLeagues.includes('cfl'), 3000);
  } finally { mgm.stop(); }
});

test('while the edge delivers, the cadence shown is the edge\'s, not this server\'s failing 30 s backoff', async () => {
  const fetchFixtures = async () => { const e = new Error('HTTP 403'); e.status = 403; throw e; };
  const { store, metrics, mgm } = source({ fetchFixtures, pollMs: 50, ownFreshMs: 100 });
  await mgm.start();
  try {
    await waitFor(() => mgm.pollMs >= 200); // own session backing off
    const t = Date.now();
    for (let i = 0; i < 4; i++) mgm.applyEdge('nfl', NFL, t + i * 2000);
    assert.equal(store.sources.betmgm.via, 'edge'); assert.equal(store.sources.betmgm.pollMs, 2000);
    await new Promise((r) => setTimeout(r, 400)); // more own failures arrive meanwhile
    assert.equal(store.sources.betmgm.pollMs, 2000, 'own failures do not overwrite the edge cadence');
    assert.equal(store.sources.betmgm.state, 'polling');
    assert.equal(metrics.mgm.pollInterval.stats().count, 0, 'failed polls never count as the feed cadence');
    assert.equal(metrics.mgm.edgeInterval.stats().p50, 2000);
    assert.match(store.sources.betmgm.ownError, /403/);
  } finally { mgm.stop(); }
});

test('the edge drops: BetMGM goes stale after its 15 s limit, and a stale BetMGM price can never win', async () => {
  const { compare } = await import('../src/model.js');
  const { store, mgm } = source(); // no browser on this server, as on Render: BetMGM only comes from the edge
  await mgm.start();
  try {
    const T = { draftkings: 75_000, fanduel: 10_000, betmgm: 15_000 }, t = Date.now();
    mgm.applyEdge('nfl', NFL, t);
    store.refreshStaleness(T, t + 5_000);
    assert.equal(store.sources.betmgm.stale, false, 'fresh while the edge sends');
    store.refreshStaleness(T, t + 16_000); // the edge sent nothing for 16 s
    assert.equal(store.sources.betmgm.stale, true, 'shown as stale, not fresh');
    assert.equal(quotesOf(store, 'betmgm').length, 90, 'its last prices stay on screen (greyed), not deleted');
    const c = compare([{ book: 'draftkings', line: null, odds: -110 }, { book: 'betmgm', line: null, odds: 250, stale: true }]);
    assert.equal(c.best.book, 'draftkings', 'a stale BetMGM price cannot be best');
  } finally { mgm.stop(); }
});
