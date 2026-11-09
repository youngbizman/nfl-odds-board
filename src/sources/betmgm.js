// BetMGM worker (Ontario).
//
// How the BetMGM website gets odds (found with tools/capture-network.mjs, Nov 9 2026):
//   1. A snapshot:  GET www.betmgm.ca/cds-api/bettingoffer/fixtures?…&sportIds=11&competitionIds=<league>&subdivision=CA-Ontario
//      → fixtures[] with participants and the game lines (moneyline / spread / totals) and American prices.
//   2. Then a push socket: wss://cds-push.betmgm.ca (SignalR, JSON), heartbeats every 15 s. Not used yet (see README).
//
// The API refuses plain HTTP clients (403), so requests are made from inside a real BetMGM page by a headless browser
// (src/sources/betmgm-browser.js). This worker polls on a fixed beat: NFL every beat, the other leagues one per beat
// in turn (live ones every beat), and backs off (×2, Retry-After honoured, max 30 s) on 403/429/5xx.
// If the cloud's own browser session cannot get answers, it asks the edge (src/edge.js, EDGE_MGM=1) for the same
// fixtures over the relay; while its own session works, anything the edge sends is counted and ignored.
//
// BetMGM serves two shapes of fixture, sometimes in the same answer:
//   v1 ("Standard"): games[] → results[] { americanOdds, attr (line), totalsPrefix, playerId = the team's participantId, visibility }
//   v2 ("PairGame"):  optionMarkets[] → options[] { price.americanOdds, parameters.fixtureParticipant = participant.id, status },
//                     participants carry properties.type HomeTeam / AwayTeam.
// slimFixtures() keeps only what the board reads from either shape; normalizeFixture() turns both into one shape.
import { parseAmerican } from '../model.js';
import { enabledLeagues, leagueGameKey, leagueOf, LEAGUES } from '../leagues.js';

const BOOK = 'betmgm';
const MARKET = { Moneyline: 'moneyline', 'Money Line': 'moneyline', Spread: 'spread', Totals: 'total', Total: 'total' };

/**
 * Keep only the fields the board reads. Runs in BetMGM's page (its source text is sent there), so it must stay
 * self-contained: no references to anything outside this function.
 */
export function slimFixtures(d) {
  const KEEP = { Moneyline: 1, 'Money Line': 1, Spread: 1, Totals: 1, Total: 1 };
  const nm = (x) => (x && typeof x === 'object' ? x.value : x);
  return {
    fixtures: ((d && d.fixtures) || []).map((f) => ({
      id: f.id, name: nm(f.name), startDate: f.startDate, stage: f.stage, isOpenForBetting: f.isOpenForBetting, fixtureType: f.fixtureType,
      competitionId: f.competition && f.competition.id,
      participants: (f.participants || []).filter((p) => !(p.properties && p.properties.type === 'Player'))
        .map((p) => ({ id: p.id, participantId: p.participantId, name: nm(p.name), type: (p.properties && p.properties.type) || null })),
      games: (f.games || []).filter((g) => KEEP[nm(g.name)]).map((g) => ({
        id: g.id, name: nm(g.name), visibility: g.visibility, attr: g.attr, isMain: g.isMain,
        results: (g.results || []).map((r) => ({ id: r.id, name: nm(r.name), americanOdds: r.americanOdds, attr: r.attr, totalsPrefix: r.totalsPrefix,
          playerId: r.playerId, visibility: r.visibility, sourceName: nm(r.sourceName) })),
      })),
      optionMarkets: (f.optionMarkets || []).filter((m) => KEEP[nm(m.name)]).map((m) => ({
        id: m.id, name: nm(m.name), status: m.status, parameters: m.parameters,
        options: (m.options || []).map((o) => ({ id: o.id, name: nm(o.name), status: o.status, americanOdds: o.price && o.price.americanOdds,
          optionTypes: o.parameters && o.parameters.optionTypes, fixtureParticipant: o.parameters && o.parameters.fixtureParticipant })),
      })),
    })),
  };
}

const num = (v) => { if (v == null || v === '') return null; if (/^\s*(pk|pick)/i.test(String(v))) return 0; const n = Number(String(v).replace('−', '-').replace(/^\+/, '')); return Number.isFinite(n) ? n : null; };
const tailNumber = (name) => { const s = String(name || ''); if (/\b(pk|pick'?em)\s*$/i.test(s)) return 0; const m = /([+-−]?\d+(?:\.\d+)?)\s*$/.exec(s); return m ? num(m[1]) : null; };
const param = (m, key) => (Array.isArray(m.parameters) ? m.parameters.find((p) => p.key === key)?.value : undefined);

/** "Kent State @ Bowling Green" / "Montreal Alouettes at Edmonton Elks (Neutral Venue)" → { away, home } names. */
export function splitName(name) {
  const s = String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const m = /^(.+?)\s+(?:@|at)\s+(.+)$/i.exec(s);
  return m ? { away: m[1].trim(), home: m[2].trim() } : null;
}

/**
 * One slim fixture → { key, home, away, start, live, markets: [{ market, offers: [{ side, line, odds, suspended }] }] }, or null
 * when the teams cannot be matched to the league's teams.
 */
export function normalizeFixture(f, league) {
  // home / away participants: v2 says so; v1 is read from "Away at Home"
  const teams = f.participants || [];
  let homeP = teams.find((p) => p.type === 'HomeTeam'), awayP = teams.find((p) => p.type === 'AwayTeam');
  const split = splitName(f.name);
  if ((!homeP || !awayP) && split) {
    const same = (p, n) => p.name && n && p.name.toLowerCase() === n.toLowerCase();
    homeP = teams.find((p) => same(p, split.home)) || { name: split.home };
    awayP = teams.find((p) => same(p, split.away)) || { name: split.away };
  }
  if (!homeP || !awayP) return null;
  const home = league.resolve(homeP.name), away = league.resolve(awayP.name);
  if (!home || !away) return null;
  const key = leagueGameKey(league.id, away, home, f.startDate);
  const closed = f.isOpenForBetting === false;
  const sideOfTeam = (name) => { const t = league.resolve(name); const k = (x) => x?.key ?? x?.abbr; return t ? (k(t) === k(home) ? 'home' : k(t) === k(away) ? 'away' : null) : null; };
  const markets = new Map(); // market → candidate list; one is picked below

  for (const g of f.games || []) { // v1
    const market = MARKET[g.name]; if (!market) continue;
    const offers = [];
    for (const r of g.results || []) {
      let side;
      if (market === 'total') side = /^over/i.test(r.totalsPrefix || r.name) ? 'over' : /^under/i.test(r.totalsPrefix || r.name) ? 'under' : null;
      else side = r.playerId != null && r.playerId === homeP.participantId ? 'home' : r.playerId != null && r.playerId === awayP.participantId ? 'away'
        : sideOfTeam(String(r.name || '').replace(/\s*[+-−]?\d+(\.\d+)?\s*$/, '')) || (r.sourceName === '1' ? 'away' : r.sourceName === '2' ? 'home' : null);
      if (!side) continue;
      const line = market === 'moneyline' ? null : market === 'total' ? (num(g.attr) ?? num(r.attr) ?? tailNumber(r.name)) : (num(r.attr) ?? tailNumber(r.name));
      offers.push({ side, line, odds: parseAmerican(r.americanOdds), suspended: closed || g.visibility !== 'Visible' || r.visibility !== 'Visible' });
    }
    (markets.get(market) || markets.set(market, []).get(market)).push({ main: !!g.isMain, offers });
  }
  for (const m of f.optionMarkets || []) { // v2
    const market = MARKET[m.name]; if (!market) continue;
    const period = param(m, 'Period'); if (period && period !== 'FullTime') continue;
    const offers = [];
    for (const o of m.options || []) {
      const types = o.optionTypes || [];
      let side;
      if (market === 'total') side = types.includes('Over') || /^over/i.test(o.name) ? 'over' : types.includes('Under') || /^under/i.test(o.name) ? 'under' : null;
      else side = o.fixtureParticipant != null && o.fixtureParticipant === homeP.id ? 'home' : o.fixtureParticipant != null && o.fixtureParticipant === awayP.id ? 'away'
        : sideOfTeam(String(o.name || '').replace(/\s*[+-−]?\d+(\.\d+)?\s*$/, ''));
      if (!side) continue;
      const line = market === 'moneyline' ? null : market === 'total' ? (num(param(m, 'DecimalValue')) ?? tailNumber(o.name)) : tailNumber(o.name);
      offers.push({ side, line, odds: parseAmerican(o.americanOdds), suspended: closed || m.status !== 'Visible' || o.status !== 'Visible' });
    }
    (markets.get(market) || markets.set(market, []).get(market)).push({ main: false, offers });
  }
  const out = [];
  for (const [market, list] of markets) {
    const usable = list.filter((c) => new Set(c.offers.map((o) => o.side)).size === 2);
    const pick = usable.find((c) => c.main) || usable[0];
    if (pick) out.push({ market, offers: pick.offers });
  }
  return { key, league: league.id, home, away, start: f.startDate, live: f.stage === 'Live', markets: out };
}

export class BetMGMSource {
  constructor(store, metrics, log, opts = {}) {
    this.store = store; this.metrics = metrics; this.log = log;
    this.leagues = (opts.leagues || enabledLeagues()).filter((l) => l.mgm);
    this.basePollMs = Number(opts.pollMs || process.env.MGM_POLL_MS || 2000);
    this.maxPollMs = 30_000; this.pollMs = this.basePollMs;
    this.fetchFixtures = opts.fetchFixtures || null;      // (competitionId) → slim fixtures; tests inject one
    this.browserEnabled = opts.browser ?? process.env.MGM_BROWSER !== '0';
    this.onNeedEdge = opts.onNeedEdge || null;             // (on, why) → ask the edge to start / stop sending BetMGM
    this.ownFreshMs = Number(opts.ownFreshMs || 20_000);   // own answers newer than this = the edge is not needed
    this.rot = 0; this.stopped = false; this.inFlight = false; this.lastPollAt = null;
    this.lastOwnOkAt = 0; this.edgeWanted = false; this.edgeLastAt = 0; this.lastOwnBeatAt = 0; this.edgeNflAt = 0;
    // Per league: when it last had a good answer (one healthy league must not keep another's old prices "fresh"),
    // and how many empty answers in a row it got (one empty answer is not trusted to wipe a league; two are).
    this.staleMs = Number(opts.staleMs || process.env.MGM_STALE_MS || 15_000);
    this.leagueOkAt = new Map(); this.emptyRuns = new Map(); this.staleLeagues = [];
  }

  async start() {
    this.store.setSource(BOOK, { mode: 'poll', state: 'connecting', region: 'Ontario', via: null, pollMs: this.pollMs, detail: 'opening a BetMGM browser session' });
    if (!this.fetchFixtures && this.browserEnabled) {
      try {
        const { BetMGMBrowser } = await import('./betmgm-browser.js');
        this.session = new BetMGMBrowser({ log: this.log });
        this.fetchFixtures = (id) => this.session.fetchFixtures(id);
      } catch (e) { this.log('mgm', `browser unavailable: ${e.message}`); }
    }
    if (!this.fetchFixtures) {
      this.needEdge(true, 'no browser on this server');
      this.store.setSource(BOOK, { state: 'down', detail: 'no BetMGM browser on this server; waiting for the edge' });
      return;
    }
    this.loop(0);
  }

  stop() { this.stopped = true; clearTimeout(this.pollTimer); this.session?.close(); }

  ownWorking(now = Date.now()) { return now - this.lastOwnOkAt < this.ownFreshMs; }

  needEdge(on, why) {
    if (on === this.edgeWanted) return;
    this.edgeWanted = on; this.log('mgm', on ? `asking the edge for BetMGM (${why})` : 'own BetMGM session works again; edge not needed');
    this.onNeedEdge?.(on, why);
  }

  fail(where, e) {
    const msg = `${where}: ${e?.message || e}`;
    this.log('mgm', msg); this.metrics.mgm.pollErrors++;
    if (!this.ownWorking()) this.needEdge(true, msg);
    // while the edge is delivering, this server's own failures must not overwrite the feed's state or its cadence
    const viaEdge = Date.now() - this.edgeLastAt < 3 * this.basePollMs + 5000;
    this.store.setSource(BOOK, viaEdge ? { ownError: msg } : { lastError: msg, ownError: msg, pollMs: this.pollMs, state: 'down' });
    this.markLeagues();
  }

  /** Leagues whose last good answer is older than the stale limit: their prices are shown greyed and can never win. */
  markLeagues(now = Date.now()) {
    const stale = this.leagues.filter((l) => now - (this.leagueOkAt.get(l.id) ?? -Infinity) > this.staleMs).map((l) => l.id);
    if (stale.join() !== this.staleLeagues.join()) { this.staleLeagues = stale; this.store.setSource(BOOK, { staleLeagues: stale }); }
  }

  /** A usable answer has a fixtures list; anything else (an error page, a changed format) is a failure, not "no games". */
  static usable(d) { return !!d && Array.isArray(d.fixtures); }

  loop(delay = this.pollMs) {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      const t0 = Date.now();
      await this.poll();
      this.loop(Math.max(0, this.pollMs - (Date.now() - t0)));
    }, delay);
  }

  /** Leagues asked on this beat: NFL always, others with a live game, and one more other league in turn. */
  beatLeagues() {
    const [first, ...others] = this.leagues; if (!first) return [];
    const live = new Set([...this.store.games.values()].filter((g) => g.status === 'live').map((g) => g.league || leagueOf(g.key)));
    const pick = new Set([first.id, ...others.filter((l) => live.has(l.id)).map((l) => l.id)]);
    if (others.length) pick.add(others[this.rot++ % others.length].id);
    return this.leagues.filter((l) => pick.has(l.id));
  }

  async poll() {
    if (this.inFlight || !this.fetchFixtures) return;
    this.inFlight = true;
    const t0 = Date.now(); const m = this.metrics.mgm;
    this.lastPollAt = t0;
    try {
      const leagues = this.beatLeagues();
      const results = await Promise.allSettled(leagues.map((l) => this.fetchFixtures(l.mgm)));
      const now = Date.now();
      let games = 0, changes = 0;
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled' && !BetMGMSource.usable(results[i].value)) results[i] = { status: 'rejected', reason: new Error('answer without a fixtures list') };
      }
      results.forEach((r, i) => {
        if (r.status === 'rejected') { if (i > 0) this.log('mgm', `${leagues[i].id} failed: ${r.reason?.message}`); return; }
        const n = this.applySnapshot(r.value, now, leagues[i].id); games += n.games; changes += n.changes;
      });
      m.polls++;
      if (results[0].status === 'rejected') {
        const e = results[0].reason; m.lastStatus = e?.status ?? null;
        if (e?.status === 429 || e?.status === 403) m.rateLimited++;
        this.pollMs = Math.min(Math.max(this.pollMs * 2, e?.retryAfterMs || 0), this.maxPollMs);
        throw new Error(`${e?.message || e} → polling every ${this.pollMs} ms`);
      }
      // timing figures come only from good answers (a failing session's 30 s backoff is not this feed's cadence)
      m.pollDuration.push(now - t0); if (this.lastOwnBeatAt) m.pollInterval.push(t0 - this.lastOwnBeatAt); this.lastOwnBeatAt = t0;
      m.lastStatus = 200; m.changesPerPoll.push(changes); m.pollChanges += changes;
      if (this.session) m.bytes.push(this.session.stats.lastBytes ?? 0);
      this.pollMs = Math.max(this.basePollMs, Math.round(this.pollMs * 0.7));
      this.lastOwnOkAt = now; this.needEdge(false);
      this.markLeagues(now);
      this.store.setSource(BOOK, { state: 'polling', via: 'browser', lastDataAt: now, lastError: null, ownError: null, polls: m.polls, pollMs: this.pollMs, lastPollMs: now - t0,
        detail: `${leagues.map((l) => l.label).join(' + ')}: ${games} games in ${now - t0} ms, every ${this.pollMs} ms (browser session)` });
    } catch (e) { this.lastOwnBeatAt = 0; this.fail('poll', e); }
    finally { this.inFlight = false; }
  }

  /** Fixtures polled by the edge (another machine). Applied only while our own session has no fresh answers. */
  applyEdge(leagueId, data, now = Date.now()) {
    if (!LEAGUES[leagueId]?.mgm || !BetMGMSource.usable(data)) return { error: 'bad message' };
    if (this.ownWorking(now)) { this.metrics.mgm.edgeIgnored++; return { ignored: 'this server polls BetMGM itself' }; }
    const m = this.metrics.mgm;
    const n = this.applySnapshot(data, now, leagueId);
    m.edgeApplied++; this.edgeLastAt = now;
    // the edge sends the NFL on every beat: the gap between two NFL answers is the cadence viewers actually get
    if (leagueId === 'nfl') { if (this.edgeNflAt && now - this.edgeNflAt < 60_000) m.edgeInterval.push(now - this.edgeNflAt); this.edgeNflAt = now; }
    this.markLeagues(now);
    const beat = m.edgeInterval.stats().p50;
    this.store.setSource(BOOK, { state: 'polling', via: 'edge', lastDataAt: now, lastError: null, pollMs: beat ? Math.round(beat) : this.basePollMs, lastPollMs: null,
      detail: `${LEAGUES[leagueId].label}: ${n.games} games via the edge` });
    return n;
  }

  /** One league's fixtures (slim) → board. Returns { games, prices, changes }. */
  applySnapshot(data, now = Date.now(), leagueId = 'nfl') {
    const league = LEAGUES[leagueId] || LEAGUES.nfl;
    let games = 0, prices = 0, changes = 0, unmatched = 0;
    const seen = new Set();
    const list = data?.fixtures || [];
    this.leagueOkAt.set(league.id, now);
    // An empty list: once may be a glitch (keep the prices); twice in a row means the league really has nothing up,
    // so its prices are taken down instead of staying on the board as if they could still be bet.
    const empties = list.length ? 0 : (this.emptyRuns.get(league.id) || 0) + 1;
    this.emptyRuns.set(league.id, empties);
    for (const f of list) {
      // (no competition check: the request already asks for one league, and BetMGM tags NFL games 103489 although the
      //  page asks for competition 35)
      const g = normalizeFixture(f, league);
      if (!g) { unmatched++; continue; }
      if (!g.markets.length) continue;
      games++;
      this.store.upsertGame({ key: g.key, league: league.id, home: g.home, away: g.away, start: g.start, books: { [BOOK]: { eventId: String(f.id), live: g.live } } });
      for (const mk of g.markets) for (const o of mk.offers) {
        const id = `${g.key}|${mk.market}|${o.side}|${BOOK}`;
        seen.add(`${g.key}|${mk.market}|${o.side}`);
        let odds = o.odds;
        if (odds == null && o.suspended) odds = this.store.quotes.get(id)?.odds ?? null; // greyed, last known price
        prices++;
        if (this.store.upsertQuote({ gameKey: g.key, market: mk.market, side: o.side, book: BOOK, line: mk.market === 'moneyline' ? null : o.line, odds, suspended: o.suspended, sourceTs: null }, now)) changes++;
      }
    }
    // a market BetMGM stopped listing must not keep showing an old price
    if (games || empties >= 2) for (const q of [...this.store.quotes.values()]) {
      if (q.book === BOOK && leagueOf(q.gameKey) === league.id && !seen.has(`${q.gameKey}|${q.market}|${q.side}`)) this.store.removeQuotes(BOOK, q.gameKey, q.market);
    }
    this.metrics.mgm.unmatched = unmatched;
    return { games, prices, changes, unmatched };
  }
}
