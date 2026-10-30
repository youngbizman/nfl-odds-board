// Board core: one SSE connection, local copy of games + quotes, filters/settings, latency measurement.
// Everything visual lives in a theme (public/themes/*.js + .css). Themes only draw; the rules live here and in
// /lib/model.js (the same file the server tests check), so switching design can never change what is shown.
import { compare, decimalOdds, cents, impliedProb, bestHold, oppositeLine, fairProb, fairAmerican, ev } from '/lib/model.js';
import pressbox from '/themes/pressbox.js';
import grid from '/themes/grid.js';

const THEMES = [pressbox, grid]; // each design is one file; with two or more, a "Design" picker appears in every theme

const BOOK = { draftkings: { label: 'DraftKings', short: 'DK', cls: 'dk' }, fanduel: { label: 'FanDuel', short: 'FD', cls: 'fd' } };
const MARKETS = [['spread', ['away', 'home']], ['total', ['over', 'under']], ['moneyline', ['away', 'home']]];
const keep = { get(k, d) { try { return localStorage.getItem(`board.${k}`) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(`board.${k}`, v); } catch {} } };
const qs = new URLSearchParams(location.search);

const LEAGUE_IDS = ['nfl', 'ncaaf', 'cfl'];
const settings = {
  league: [...LEAGUE_IDS, 'all'].includes(qs.get('league')) ? qs.get('league') : 'nfl', // nfl | ncaaf | cfl | all (?league= is shareable)
  singleBook: false,                                                // college: also show games only one book prices
  game: qs.get('game') || null,                                     // a game's own page (?game=KEY)
  range: ['10m', '1h', '6h', '1d', '1w', 'all'].includes(qs.get('range')) ? qs.get('range') : null, // its chart window (null = automatic)
  view: qs.get('view') || 'best',                                   // best | draftkings | fanduel (?view= is shareable)
  phase: 'all',                                                     // all | live | pregame
  search: '',
  format: keep.get('format', 'american'),                           // american | decimal
  // The page always opens light, in the first design. Another design or dark mode is a choice that lives in the link
  // (?theme=grid, ?scheme=dark), so a reload keeps it but a fresh visit never starts dark or in the engineering view.
  theme: THEMES.some((t) => t.id === qs.get('theme')) ? qs.get('theme') : THEMES[0].id,
  density: keep.get('density', 'comfortable'),                      // comfortable | compact
  scheme: qs.get('scheme') === 'dark' ? 'dark' : 'light',          // light (default) | dark
};
try { localStorage.removeItem('board.theme'); localStorage.removeItem('board.scheme'); } catch {} // older versions remembered these
const setParam = (k, v, dflt) => { const u = new URL(location.href); v === dflt ? u.searchParams.delete(k) : u.searchParams.set(k, v); history.replaceState(null, '', u); };
const starred = new Set((() => { try { return JSON.parse(keep.get('starred', '[]')); } catch { return []; } })());
const state = { games: new Map(), quotes: new Map(), sources: {}, config: { staleMs: { draftkings: 75000, fanduel: 10000 } },
  offset: 0, rtt: null, connected: false, everConnected: false, moves: [], moveCount: { draftkings: 0, fanduel: 0 }, changedAt: new Map(),
  history: new Map(), histFrom: null, chartPick: new Map(), // movement charts: quote id -> [[t, odds, line]]
  extrasSummary: {}, extrasKinds: {}, extras: new Map(), extrasHolds: [],
  gameHistory: null, // the open game's page: { key, map: quote id -> [[t, odds, line]] } at full resolution, up to a week
  leagues: [{ id: 'nfl', label: 'NFL', title: 'NFL', games: null }, { id: 'ncaaf', label: 'College', title: 'College football', games: null }, { id: 'cfl', label: 'CFL', title: 'CFL', games: null }] };   // "more lines": per-game counts, and the open drop-downs
// Latency samples measured in THIS browser (nothing here is assumed or defaulted):
//   hop   server stamped the quote → this page received it        (per book)
//   e2e   DraftKings published it  → this page received it        (DraftKings stamps every change)
//   drawn DraftKings published it  → the next frame on this screen after it was drawn
const lat = { pushLag: { draftkings: [], fanduel: [] }, endToEnd: { draftkings: { pregame: [], live: [] } }, drawn: [],
  recent: { draftkings: [], fanduel: [], e2e: [], drawn: [] }, at: {} };

// ---------- helpers given to themes ----------
const serverNow = () => Date.now() + state.offset;
const minus = (s) => String(s).replace('-', '−');
function fmtOdds(a) {
  if (a == null) return '—';
  if (settings.format === 'decimal') return decimalOdds(a).toFixed(3);
  return a > 0 ? `+${a}` : minus(a);
}
function fmtLine(market, side, l) {
  if (l == null) return '';
  if (market === 'total') return `${side === 'over' ? 'O' : 'U'} ${l}`;
  return l > 0 ? `+${l}` : l === 0 ? 'PK' : minus(l);
}
function ago(ts, now = serverNow()) {
  if (!ts) return 'never'; const s = Math.max(0, (now - ts) / 1000);
  return s < 10 ? `${s.toFixed(1)} s ago` : s < 60 ? `${Math.round(s)} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}
const secs = (ms) => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const pct = (arr, q) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const quote = (gk, m, side, book) => state.quotes.get(`${gk}|${m}|${side}|${book}`);
// A dropped stream only counts as lost after a short grace (a league switch or a 1 s network blip reconnects by itself;
// flashing a red "connection lost" for that would cry wolf). Within the grace the page says "connecting", in neutral colours.
const LOST_GRACE_MS = 4000;
const connectionLost = () => !state.connected && state.everConnected && !state.switching && state.lostSince != null && Date.now() - state.lostSince > LOST_GRACE_MS;
const bookDown = (book) => { const s = state.sources[book]; return !s || s.stale || s.state === 'down' || connectionLost(); };
const feedState = (book) => { const s = state.sources[book] || {}; if (connectionLost()) return 'lost'; if (!state.connected) return 'connecting'; if (s.state === 'down') return 'reconnecting'; if (s.stale) return 'stale'; if (s.state === 'connecting' || !s.lastDataAt) return 'connecting'; return 'live'; };

/** How a quote moved recently: for flashes (≤ 0.7 s) and the struck-through previous value (≤ 8 s). */
function change(q, now = Date.now()) {
  const at = q && state.changedAt.get(q.id); if (!at || now - at > 8000) return null;
  const lineMoved = q.prevLine != null && q.prevLine !== q.line;
  const dir = !lineMoved && q.prevOdds != null && q.odds != null ? (q.odds > q.prevOdds ? 'up' : q.odds < q.prevOdds ? 'down' : '') : '';
  return { at, dir, lineMoved, prevOdds: q.prevOdds, prevLine: q.prevLine, flash: now - at < 700 };
}

/** Everything a theme needs to draw one side of one market. */
function cell(g, market, side) {
  const offer = (book) => { const q = quote(g.key, market, side, book); return q ? { ...q, book, stale: bookDown(book) } : null; };
  const dk = offer('draftkings'), fd = offer('fanduel');
  if (settings.view !== 'best') return { view: settings.view, single: settings.view === 'draftkings' ? dk : fd };
  return { view: 'best', dk, fd, cmp: compare([dk, fd]) };
}

/** Movement chart data for one side of one market of a game: each book's [t, odds, line] points in the window. */
function series(g, market, side) {
  const now = serverNow(); const live = phaseOf(g) === 'live';
  let from = state.histFrom ?? now - 3600_000;
  if (live && g.start) from = Math.max(from, new Date(g.start).getTime() - 15 * 60_000); // a live game: chart the game itself
  // the chart starts where this price's recorded history starts, so the box is always filled (no empty stretch)
  let first = Infinity; for (const b of Object.keys(BOOK)) { const h = state.history.get(`${g.key}|${market}|${side}|${b}`); if (h?.length) first = Math.min(first, h[0][0]); }
  if (Number.isFinite(first)) from = Math.max(from, Math.min(first, now - 60_000));
  const books = {};
  for (const b of Object.keys(BOOK)) {
    const id = `${g.key}|${market}|${side}|${b}`; const q = state.quotes.get(id);
    let pts = (state.history.get(id) || []).filter((p) => p[0] >= from);
    const before = (state.history.get(id) || []).filter((p) => p[0] < from).pop();
    if (before) pts = [[from, before[1], before[2]], ...pts];
    if (!pts.length && q?.odds != null) pts = [[from, q.odds, q.line ?? null]];
    books[b] = pts;
  }
  return { from, to: now, live, books };
}
/** Same as series(), for a chosen window, from the open game's full-resolution history when it is loaded. */
function seriesRange(g, market, side, ms) {
  const now = serverNow(); const from = now - ms; const books = {}; let recordedFrom = now;
  const src = state.gameHistory?.key === g.key ? state.gameHistory.map : state.history;
  for (const b of Object.keys(BOOK)) {
    const id = `${g.key}|${market}|${side}|${b}`; const all = src.get(id) || state.history.get(id) || []; const q = state.quotes.get(id);
    if (all.length) recordedFrom = Math.min(recordedFrom, all[0][0]);
    let pts = all.filter((p) => p[0] >= from); const before = all.filter((p) => p[0] < from).pop();
    if (before) pts = [[from, before[1], before[2]], ...pts];
    if (!pts.length && q?.odds != null) pts = [[from, q.odds, q.line ?? null]];
    books[b] = pts;
  }
  return { from, to: now, books, recordedFrom };
}
async function loadGameHistory(key) {
  try {
    const h = await (await fetch(`/api/history?game=${encodeURIComponent(key)}&hours=192`, { cache: 'no-store' })).json();
    if (settings.game !== key || !h.series) return;
    const map = new Map(Object.entries(h.series).map(([id, pts]) => [id, pts.map(([sec, o, l]) => [h.from + sec * 1000, o, l])]));
    for (const [id, pts] of state.history) if (id.startsWith(`${key}|`)) { const m = map.get(id) || []; const lastT = m.length ? m[m.length - 1][0] : 0; for (const p of pts) if (p[0] > lastT) m.push(p); map.set(id, m); }
    state.gameHistory = { key, map }; theme.render();
  } catch {}
}
function openGame(key, { push = true } = {}) {
  if (!key) return closeGame({ push });
  settings.game = key; state.gameHistory = null;
  if (push) { settings.range = null; setParam('range', null, null); } // each game opens on its own default window
  if (push) { const u = new URL(location.href); u.searchParams.set('game', key); history.pushState({ game: key }, '', u); }
  // its alt lines and props open by themselves on its page (NFL)
  if (state.extrasSummary[key] && !state.extras.has(key)) toggleExtras(key);
  loadGameHistory(key); theme.render(); window.scrollTo({ top: 0 });
}
function closeGame({ push = true } = {}) {
  if (!settings.game) return;
  const was = settings.game; settings.game = null; state.gameHistory = null;
  if (push) { const u = new URL(location.href); u.searchParams.delete('game'); history.pushState({}, '', u); }
  theme.render(); requestAnimationFrame(() => document.querySelector(`[data-game="${CSS.escape(was)}"]`)?.scrollIntoView({ block: 'center' }));
}
window.addEventListener('popstate', () => { const k = new URLSearchParams(location.search).get('game'); if (k !== settings.game) (k ? openGame(k, { push: false }) : closeGame({ push: false })); });
const chartPick = (gk) => state.chartPick.get(gk) || { market: 'moneyline', side: 'home' };

// ---------- "more lines" drop-down: one stream per open game ----------
const KIND_ORDER = ['alt-spread', 'alt-total', 'td', 'pass-yds', 'rush-yds', 'rec-yds', 'receptions'];
async function loadExtrasSummary() {
  try { const r = await (await fetch('/api/extras/summary', { cache: 'no-store' })).json(); state.extrasSummary = r.games || {}; state.extrasKinds = r.kinds || {}; state.extrasHolds = r.holds || []; theme.renderExtrasToggles?.(); theme.renderHolds?.(); } catch {}
  if (settings.game && state.extrasSummary[settings.game] && !state.extras.has(settings.game)) toggleExtras(settings.game); // a game page opened from a link
}
function toggleExtras(gk) {
  const cur = state.extras.get(gk);
  if (cur) { cur.es.close(); clearInterval(cur.watch); state.extras.delete(gk); theme.renderGame(gk); return; }
  const x = { rows: new Map(), kind: null, bothOnly: true, status: {}, loaded: false, es: new EventSource(`/api/extras/stream?game=${encodeURIComponent(gk)}`) };
  state.extras.set(gk, x);
  x.es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data); x.rows = new Map(d.rows.map((r) => [r.key, r])); x.status = d.status; if (d.kinds) state.extrasKinds = d.kinds; x.loaded = true;
    if (!x.kind) x.kind = KIND_ORDER.find((k) => [...x.rows.values()].some((r) => r.kind === k && r.offers.draftkings && r.offers.fanduel)) || KIND_ORDER.find((k) => [...x.rows.values()].some((r) => r.kind === k)) || 'alt-spread';
    theme.renderExtras(gk);
  });
  x.lastAt = Date.now();
  for (const ev of ['snapshot', 'rows', 'status']) x.es.addEventListener(ev, () => { x.lastAt = Date.now(); });
  x.watch = setInterval(() => { if (state.extras.get(gk) !== x) return clearInterval(x.watch); if (Date.now() - x.lastAt > 10_000) { clearInterval(x.watch); x.es.close(); state.extras.delete(gk); toggleExtras(gk); } }, 2000);
  x.es.addEventListener('status', (e) => {
    const before = JSON.stringify(Object.keys(BOOK).map((b) => !!x.status?.[b]?.stale));
    x.status = JSON.parse(e.data);
    if (JSON.stringify(Object.keys(BOOK).map((b) => !!x.status?.[b]?.stale)) !== before) theme.renderExtras(gk); // a book went stale / came back
    for (const b of Object.keys(BOOK)) document.querySelectorAll(`[data-x-age="${b}"]`).forEach((n) => { n.dataset.ageTs = x.status[b]?.lastDataAt || ''; }); });
  x.es.addEventListener('rows', (e) => {
    const local = Date.now();
    for (const r of JSON.parse(e.data).rows) {
      if (!Object.keys(r.offers).length) { x.rows.delete(r.key); continue; }
      const prev = x.rows.get(r.key); r.changedAt = { ...(prev?.changedAt || {}) };
      for (const [b, o] of Object.entries(r.offers)) if (prev?.offers[b] && prev.offers[b].odds !== o.odds) r.changedAt[b] = local;
      x.rows.set(r.key, r);
    }
    theme.renderExtras(gk);
    setTimeout(() => state.extras.get(gk) === x && theme.renderExtras(gk), 8100);
  });
  theme.renderGame(gk);
}
/** What the drop-down shows: one kind's rows, ranked with the same compare() as the board, sorted for reading. */
function extrasView(gk) {
  const x = state.extras.get(gk); if (!x) return null;
  const g = state.games.get(gk); const all = [...x.rows.values()];
  const counts = {}; for (const r of all) { const both = !!(r.offers.draftkings && r.offers.fanduel); counts[r.kind] ||= { all: 0, both: 0 }; counts[r.kind].all++; if (both) counts[r.kind].both++; }
  const now = Date.now();
  const rows = all.filter((r) => r.kind === x.kind && (!x.bothOnly || (r.offers.draftkings && r.offers.fanduel))).map((r) => {
    // a book whose feed is down, or whose more-lines data went quiet (server says stale), cannot be best here either
    const offers = Object.keys(BOOK).map((b) => r.offers[b] ? { ...r.offers[b], book: b, line: r.line, stale: bookDown(b) || !!x.status?.[b]?.stale, moved: r.changedAt?.[b] && now - r.changedAt[b] < 8000 ? (r.offers[b].odds > (r.offers[b].prevOdds ?? r.offers[b].odds) ? 'up' : 'down') : null } : null);
    const label = r.kind === 'alt-spread' ? `${g?.[r.subject]?.abbr ?? r.subject} ${fmtLine('spread', r.subject, r.line)}` : r.kind === 'alt-total' ? `${r.subject === 'over' ? 'Over' : 'Under'} ${r.line}` : r.kind === 'td' ? r.name : `${r.name} · ${r.line}+`;
    return { ...r, label, cells: offers, cmp: compare(offers) };
  });
  const fav = (r) => Math.min(...r.cells.filter(Boolean).map((o) => decimalOdds(o.odds)));
  const sorters = {
    'alt-spread': (a, b) => (a.subject === b.subject ? a.line - b.line : a.subject === 'away' ? -1 : 1),
    'alt-total': (a, b) => a.line - b.line || (a.subject === 'over' ? -1 : 1),
    td: (a, b) => fav(a) - fav(b),
  };
  rows.sort(sorters[x.kind] || ((a, b) => (a.name || '').localeCompare(b.name || '') || a.line - b.line));
  return { kind: x.kind, bothOnly: x.bothOnly, loaded: x.loaded, status: x.status, rows, counts, kinds: KIND_ORDER.filter((k) => counts[k]).map((k) => ({ id: k, label: state.extrasKinds[k] || k, ...counts[k] })) };
}

/** Both books' offers for one side of one market, whatever the view (the grid design shows all columns at once). */
function both(g, market, side) {
  const offer = (book) => { const q = quote(g.key, market, side, book); return q ? { ...q, book, stale: bookDown(book) } : null; };
  const dk = offer('draftkings'), fd = offer('fanduel');
  return { dk, fd, cmp: compare([dk, fd]) };
}
const OTHER = { away: 'home', home: 'away', over: 'under', under: 'over' };
/** Fair (no-vig) chance of one side at the best line, from every book pricing both sides there; and the best price's EV. */
function fair(g, market, side) {
  const c = both(g, market, side); const line = c.cmp.best?.line ?? c.dk?.line ?? c.fd?.line ?? null;
  const pair = market === 'spread' ? oppositeLine : (l) => l;
  const pairs = Object.keys(BOOK).map((b) => {
    const a = quote(g.key, market, side, b), o = quote(g.key, market, OTHER[side], b);
    if (!a || !o || a.suspended || o.suspended || bookDown(b)) return null;
    return (a.line ?? null) === (market === 'moneyline' ? null : line) && (o.line ?? null) === (market === 'moneyline' ? null : pair(line)) ? [a.odds, o.odds] : null;
  }).filter(Boolean);
  const p = fairProb(pairs);
  return { p, fair: fairAmerican(p), ev: c.cmp.best && p != null ? ev(c.cmp.best.odds, p) : null, books: pairs.length, line };
}

function phaseOf(g) { return g.status === 'live' ? 'live' : 'pregame'; }
/** Lowest hold per market for one game: best open price on each side from either book, matching lines only. */
function holds(g) {
  const offers = (market, side) => Object.keys(BOOK).map((b) => { const q = quote(g.key, market, side, b); return q ? { ...q, book: b, stale: bookDown(b) } : null; }).filter(Boolean);
  return {
    spread: bestHold(offers('spread', 'away'), offers('spread', 'home'), oppositeLine),
    total: bestHold(offers('total', 'over'), offers('total', 'under')),
    moneyline: bestHold(offers('moneyline', 'away'), offers('moneyline', 'home')),
  };
}
/** The tightest markets across the board (game lines), lowest hold first. Negative hold = arbitrage. */
function tightest(n = 6) {
  const out = [];
  for (const g of state.games.values()) for (const [market, h] of Object.entries(holds(g))) if (h && !h.a?.stale && !h.b?.stale) out.push({ game: g, market, ...h });
  return out.sort((a, b) => a.hold - b.hold).slice(0, n);
}
/** Games priced by only one book. In college football FanDuel also lists ~50 small-school (FCS) games DraftKings does not,
 *  so outside the NFL those are hidden by default (nothing to compare) and one click shows them. */
function bookCount(gk) { const b = new Set(); for (const q of state.quotes.values()) if (q.gameKey === gk) b.add(q.book); return b.size; }
const leagueOfKey = (k) => /^(ncaaf|cfl):/.exec(k || '')?.[1] || 'nfl';
const hideSingles = () => settings.league !== 'nfl' && !settings.singleBook; // outside the NFL, games one book prices are hidden until asked for
function hiddenSingles() {
  if (!hideSingles()) return 0;
  const withPrices = new Set([...state.quotes.values()].map((q) => q.gameKey));
  return [...state.games.values()].filter((g) => withPrices.has(g.key) && leagueOfKey(g.key) !== 'nfl' && bookCount(g.key) < 2).length;
}
function visibleGames() {
  if (settings.game) { const g = state.games.get(settings.game); return g ? [g] : []; } // a game's own page
  const withPrices = new Set([...state.quotes.values()].map((q) => q.gameKey));
  const term = settings.search.trim().toLowerCase();
  const single = hideSingles();
  return [...state.games.values()]
    .filter((g) => withPrices.has(g.key))
    .filter((g) => !single || leagueOfKey(g.key) === 'nfl' || bookCount(g.key) >= 2)
    .filter((g) => settings.phase === 'all' || (settings.phase === 'starred' ? starred.has(g.key) : phaseOf(g) === settings.phase))
    .filter((g) => !term || [g.away.abbr, g.home.abbr, g.away.name, g.home.name, g.away.nick, g.home.nick].some((x) => String(x || '').toLowerCase().includes(term)))
    .sort((a, b) => (phaseOf(a) === 'live' ? 0 : 1) - (phaseOf(b) === 'live' ? 0 : 1) || new Date(a.start) - new Date(b.start) || a.key.localeCompare(b.key));
}
/** Games in display groups: starred first, then live, then each kickoff slot. With "All" leagues the board is split by
 *  league (NFL, then college, then CFL), each with the same groups inside and a league header on its first group. */
function groups() {
  const out = new Map(); const vis = visibleGames(); const all = settings.league === 'all' && !settings.game;
  if (settings.phase !== 'starred') for (const g of vis) if (starred.has(g.key)) { if (!out.has('starred')) out.set('starred', { key: 'starred', starred: true, start: null, games: [] }); out.get('starred').games.push(g); }
  for (const lg of all ? LEAGUE_IDS : [null]) {
    const games = vis.filter((g) => (!lg || leagueOfKey(g.key) === lg) && (settings.phase === 'starred' || !starred.has(g.key)));
    let first = true;
    for (const g of games) {
      const k = `${lg || ''}|${phaseOf(g) === 'live' ? 'live' : g.start}`;
      if (!out.has(k)) {
        const meta = lg && first ? { leagueHead: { id: lg, ...(state.leagues.find((l) => l.id === lg) || { label: lg, title: lg }), count: games.length } } : {};
        out.set(k, { key: k, live: phaseOf(g) === 'live', start: phaseOf(g) === 'live' ? null : new Date(g.start), games: [], ...meta }); first = false;
      }
      out.get(k).games.push(g);
    }
  }
  return [...out.values()];
}
/**
 * Latency for one book, only from real samples. Each figure is a median with its sample count (n), when the latest
 * sample was taken (at), and how far the clocks involved can be off (pm, ± ms; null = cannot be bounded).
 *   server  the book's own change stamp → our server received it (measured on the server)
 *   page    the book's stamp → this page received it (DraftKings only: it stamps every change)
 *   drawn   the book's stamp → drawn on this screen (next frame after the update was applied)
 *   hop     our server → this page
 * A figure with no samples is null and the page says it is waiting; nothing is filled in with a guess.
 */
function latency(book) {
  const s = state.sources[book] || {};
  const syncPm = state.rtt != null ? Math.ceil(state.rtt / 2) : null; // this browser's clock vs the server's (NTP-style, ≤ RTT/2)
  const sample = (k, pm) => (lat.recent[k].length ? { p50: pct(lat.recent[k], 0.5), n: lat.recent[k].length, at: lat.at[k] ?? null, pm } : null);
  const hop = sample(book, syncPm);
  if (book === 'draftkings') {
    const dkPm = s.clockUncertaintyMs ?? null; // DraftKings' clock vs the server's, from the subscribe ack
    const both = dkPm != null && syncPm != null ? dkPm + syncPm : null;
    const server = s.lagP50Ms != null && s.lagCount ? { p50: s.lagP50Ms, n: s.lagCount, at: s.lagAt ?? null, pm: dkPm, phase: s.lagPhase || null } : null;
    return { push: true, server, page: sample('e2e', both), drawn: sample('drawn', both), hop, syncPm };
  }
  const beat = (s.pollMs || 1000) / (s.interleave ? 2 : 1);
  const push = s.push === 'live';
  // FanDuel stamps pushed markets with its own clock, which we cannot sync: pm stays null (unknown), never 0
  const server = push && s.pushLagP50Ms != null && s.pushLagCount ? { p50: s.pushLagP50Ms, n: s.pushLagCount, at: s.pushLagAt ?? null, pm: null } : null;
  const serverMaxAgeMs = beat + (s.lastPollMs || 0); // polling bound: a change waits at most one beat + one request
  return { beatMs: beat, freshMs: s.freshP50Ms ?? beat, serverMaxAgeMs, interleave: !!s.interleave, push, server, page: null, drawn: null, hop, syncPm };
}
/** The same figures as words, for the feed panels of both designs. */
function latencyText(book) {
  const L = latency(book); const B = book === 'draftkings' ? 'DraftKings' : 'FanDuel';
  const pm = (x) => (x.pm != null ? `, clocks ±${x.pm} ms` : book === 'fanduel' && x === L.server ? ", FanDuel's clock (not synced)" : ', clocks not synced yet');
  const fig = (x) => `${secs(x.p50)} (median of ${x.n}${pm(x)}${x.at ? `, last ${ago(x.at)}` : ''})`;
  const lines = [];
  if (L.server) lines.push(`${B} → our server ${fig(L.server)}`);
  else if (book === 'draftkings' || L.push) lines.push(`${B} → our server: no samples yet`);
  if (book === 'fanduel' && !L.push) lines.push(`polled every ${secs(L.beatMs)}: a change reaches our server at most ${secs(L.serverMaxAgeMs)} later`);
  if (L.page) lines.push(`${B} → this page ${fig(L.page)}`);
  else if (L.hop) lines.push(`our server → this page ${fig(L.hop)}`);
  else lines.push('this page: measured on the next price move');
  if (L.drawn) lines.push(`drawn on screen ${fig(L.drawn)}`);
  // compact: the best figure we have, labelled with where it ends
  const short = L.page ? `${secs(L.page.p50)} to page` : L.server ? `${secs(L.server.p50)} to server` : book === 'fanduel' && !L.push ? `≤ ${secs(L.serverMaxAgeMs)} to server` : 'measuring';
  return { L, lines, short, title: lines.join('\n') };
}
function freshness(book, now = serverNow()) {
  const s = state.sources[book] || {}; const limit = state.config.staleMs?.[book] || 60000;
  const age = s.lastDataAt ? now - s.lastDataAt : limit;
  return { age, fill: Math.max(0, Math.min(1, 1 - age / limit)) };
}

const api = { BOOK, MARKETS, state, settings, themes: THEMES, fmtOdds, fmtLine, ago, secs, serverNow, quote, cell, change, groups, visibleGames, phaseOf, latencyText,
  connectionLost, feedState, latency, freshness, bookDown, series, seriesRange, chartPick, decimalOdds, cents, impliedProb, holds, tightest, both, fair, hiddenSingles,
  openGame, closeGame, game: () => (settings.game ? state.games.get(settings.game) || null : null),
  setRange(r) { settings.range = r; setParam('range', r, null); if (settings.game) theme.renderGame(settings.game); else theme.render(); },
  /** When the board's price history for this game begins (its first recorded price, any market, either book). */
  gameRecordedFrom(g) {
    const src = state.gameHistory?.key === g.key ? state.gameHistory.map : state.history; let first = null;
    for (const [id, pts] of src) if (pts.length && id.startsWith(`${g.key}|`) && (first == null || pts[0][0] < first)) first = pts[0][0];
    return first;
  },
  league: () => (settings.league === 'all' ? { id: 'all', label: 'All', title: 'All leagues', games: state.leagues.reduce((n, l) => n + (l.games || 0), 0) } : state.leagues.find((l) => l.id === settings.league) || state.leagues[0]),
  /** The league buttons: All, then each league, with game counts. */
  leagueOptions: () => [{ id: 'all', label: 'All', title: 'Every league', games: state.leagues.reduce((n, l) => n + (l.games || 0), 0) }, ...state.leagues],
  leagueOfKey,
  setLeague(id) {
    if (![...LEAGUE_IDS, 'all'].includes(id) || id === settings.league) return;
    settings.league = id; settings.search = ''; settings.phase = 'all'; settings.singleBook = false; settings.game = null; state.gameHistory = null; setParam('game', null, null); setParam('league', id, 'nfl');
    for (const x of state.extras.values()) { x.es.close(); clearInterval(x.watch); } state.extras.clear();
    state.games = new Map(); state.quotes = new Map(); state.moves = []; state.moveCount = { draftkings: 0, fanduel: 0 }; state.history = new Map(); state.histFrom = null; state.changedAt.clear();
    state.switching = true; mountTheme(theme); reconnect('league changed', 0);
  },
  isStarred: (gk) => starred.has(gk),
  toggleStar(gk) { starred.has(gk) ? starred.delete(gk) : starred.add(gk); keep.set('starred', JSON.stringify([...starred])); theme.render(); },
  pickChart(gk, market, side) { state.chartPick.set(gk, { market, side }); theme.renderGame(gk); },
  toggleExtras, extrasView, extrasOpen: (gk) => state.extras.has(gk), extrasCount: (gk) => state.extrasSummary[gk] || null,
  setExtras(gk, patch) { const x = state.extras.get(gk); if (!x) return; Object.assign(x, patch); theme.renderExtras(gk); },
  set(key, value) {
    settings[key] = value;
    if (['format', 'density'].includes(key)) keep.set(key, value);
    if (key === 'density' || key === 'scheme') applyLook();
    if (key === 'scheme') setParam('scheme', value, 'light');
    if (key === 'view') setParam('view', value, 'best');
    theme.render();
  },
  setTheme(id) { const t = THEMES.find((x) => x.id === id); if (!t || t === theme) return; settings.theme = id; setParam('theme', id, THEMES[0].id); mountTheme(t); },
  /** How much better price a is than b, in the unit bettors use: cents near even money, % more profit for big favourites/longshots. */
  edge(a, b) {
    if (a == null || b == null) return null;
    const c = cents(a, b);
    if (c <= 30) return { text: `+${c}¢`, title: `${c} cents better (${fmtOdds(a)} vs ${fmtOdds(b)})` };
    // −650 vs −800 is "150 cents", which means nothing to most people: say how much more it pays instead
    const pa = decimalOdds(a) - 1, pb = decimalOdds(b) - 1; const p = Math.round(((pa - pb) / pb) * 100);
    return { text: `+${p}% payout`, title: `wins ${p}% more than ${fmtOdds(b)} for the same stake` };
  },
};

// ---------- look: density + light/dark (attributes on <html>; themes style them) ----------
function applyLook() {
  const html = document.documentElement;
  html.dataset.density = settings.density;
  html.dataset.scheme = settings.scheme;
}
applyLook();

// ---------- keyboard: / search · 1 2 3 views · c compact · d dark · s star · ? help ----------
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (e.key === 'Escape') { if (typing) e.target.blur(); else if (settings.game) closeGame(); theme.closeHelp?.(); return; }
  if (typing) return;
  const act = {
    '/': () => theme.focusSearch?.(),
    1: () => api.set('view', 'best'), 2: () => api.set('view', 'draftkings'), 3: () => api.set('view', 'fanduel'),
    c: () => api.set('density', settings.density === 'compact' ? 'comfortable' : 'compact'),
    d: () => api.set('scheme', document.documentElement.dataset.scheme === 'dark' ? 'light' : 'dark'),
    s: () => { const gk = document.activeElement?.closest?.('[data-game]')?.dataset.game; if (gk) api.toggleStar(gk); },
    '?': () => theme.toggleHelp?.(),
  }[e.key];
  if (act) { e.preventDefault(); act(); }
});

// ---------- theme mounting ----------
let theme = null;
function link(id, href) { let el = document.getElementById(id); if (!href) { el?.remove(); return; } if (!el) { el = document.createElement('link'); el.id = id; el.rel = 'stylesheet'; document.head.appendChild(el); } if (el.getAttribute('href') !== href) el.href = href; }
function mountTheme(t) {
  theme?.unmount?.();
  theme = t;
  link('theme-fonts', t.fonts); link('theme-css', t.css);
  document.documentElement.dataset.theme = t.id;
  document.body.className = t.bodyClass || '';
  t.mount(document.getElementById('app'), api);
  t.render();
}

// ---------- clock + stream ----------
async function syncClock() {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now(); let serverTs;
    try { ({ serverTs } = await (await fetch('/api/time', { cache: 'no-store', signal: AbortSignal.timeout(4000) })).json()); } catch { continue; } // flaky network: keep the last offset
    const t1 = Date.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, off: serverTs - (t0 + t1) / 2 };
  }
  if (best) { state.offset = best.off; state.rtt = best.rtt; }
}
// The stream can die silently: a flaky network (seen live: HTTP/3 'QUIC idle timeout' on a home connection) can leave
// EventSource "open" while nothing arrives, so the page would look live with frozen prices. The server speaks at least
// every 5 s (heartbeat), so 12 s of silence = dead stream: show "reconnecting", grey out prices, open a fresh stream.
const STALL_MS = 12_000;
let stream = null, lastMsgAt = 0, reconnectTimer = null, retryMs = 1000;
function heard() { lastMsgAt = Date.now(); retryMs = 1000; }
function reconnect(why, delay = retryMs) {
  stream?.close(); stream = null;
  if (state.lostSince == null) state.lostSince = Date.now();
  if (state.connected) { state.connected = false; theme.render(); }
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
  if (delay) retryMs = Math.min(retryMs * 2, 15_000);
  console.info(`[board] stream ${why} → reconnecting`);
}
setInterval(() => { if (stream && lastMsgAt && Date.now() - lastMsgAt > STALL_MS) reconnect('silent for 12 s'); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && stream && Date.now() - lastMsgAt > STALL_MS) reconnect('stale after the tab was hidden'); });
function connect() {
  const es = new EventSource(`/api/stream?league=${settings.league}`); stream = es; lastMsgAt = Date.now();
  for (const ev of ['snapshot', 'batch', 'beat']) es.addEventListener(ev, heard);
  es.addEventListener('snapshot', (e) => {
    const s = JSON.parse(e.data);
    // a new deploy: the server came back with another version → load the new page once (open tabs never keep old code)
    if (s.version && state.version && s.version !== state.version && s.version !== 'dev') { location.reload(); return; }
    state.version = s.version;
    state.games = new Map(s.games.map((g) => [g.key, g])); state.quotes = new Map(s.quotes.map((q) => [q.id, q]));
    state.sources = s.sources; if (s.config) state.config = s.config; if (s.leagues?.length) state.leagues = s.leagues;
    state.connected = true; state.everConnected = true; state.lostSince = null; state.switching = false;
    theme.render();
    loadHistory();
    if (settings.game && !state.gameHistory) { if (state.games.has(settings.game)) loadGameHistory(settings.game); }
  });
  es.addEventListener('batch', (e) => applyBatch(JSON.parse(e.data)));
  es.addEventListener('beat', (e) => { for (const [b, [d, c]] of Object.entries(JSON.parse(e.data))) { const s = state.sources[b]; if (s) { s.lastDataAt = d; s.lastChangeAt = c; } } theme.renderFeeds(); });
  es.onerror = () => {
    if (es !== stream) return;
    if (es.readyState === EventSource.CLOSED) return reconnect('closed'); // the browser gave up (HTTP error): we retry with backoff
    if (state.lostSince == null) state.lostSince = Date.now();
    state.connected = false; theme.renderBanner(); theme.renderFeeds();   // otherwise EventSource retries by itself; a fresh snapshot follows
  };
}
async function loadHistory() { // the last 48 h of every price, for the movement charts
  try {
    const league = settings.league;
    const h = await (await fetch(`/api/history?hours=48&points=90&league=${league}`, { cache: 'no-store' })).json();
    if (league !== settings.league) return; // switched league while this was loading
    const live = state.history; state.histFrom = h.from;
    state.history = new Map(Object.entries(h.series).map(([id, pts]) => [id, pts.map(([sec, o, l]) => [h.from + sec * 1000, o, l])]));
    for (const [id, pts] of live) { const h2 = state.history.get(id) || []; const lastT = h2.length ? h2[h2.length - 1][0] : 0; for (const p of pts) if (p[0] > lastT) h2.push(p); state.history.set(id, h2); }
    theme.render();
  } catch {}
}
function pushHistory(q) {
  if (q.odds == null) return;
  const h = state.history.get(q.id) || []; const last = h[h.length - 1];
  if (!last || last[1] !== q.odds || last[2] !== (q.line ?? null)) { h.push([q.updatedAt, q.odds, q.line ?? null]); if (h.length > 2000) h.shift(); state.history.set(q.id, h); }
  const gh = state.gameHistory; if (gh && q.gameKey === gh.key) { const m = gh.map.get(q.id) || []; const l2 = m[m.length - 1]; if (!l2 || l2[1] !== q.odds || l2[2] !== (q.line ?? null)) { m.push([q.updatedAt, q.odds, q.line ?? null]); gh.map.set(q.id, m); } }
}
function applyBatch(b) {
  const now = serverNow(), local = Date.now(); const touched = new Set(); let structural = false;
  for (const g of b.games || []) { const prev = state.games.get(g.key); if (!prev || prev.status !== g.status) structural = true; state.games.set(g.key, { ...(prev || {}), ...g }); touched.add(g.key); }
  for (let q of b.quotes || []) {
    touched.add(q.gameKey);
    if (q.removed) { state.quotes.delete(q.id); structural = true; continue; }
    const old = state.quotes.get(q.id); if (!old) structural = true;
    // only open/suspended changed: keep the last price move (arrow, struck-through old price), and it is not a move
    const availOnly = old && old.odds === q.odds && (old.line ?? null) === (q.line ?? null);
    if (availOnly) q = { ...q, prevOdds: old.prevOdds, prevLine: old.prevLine };
    state.quotes.set(q.id, q); pushHistory(q);
    const moved = !availOnly && ((q.prevOdds != null && q.prevOdds !== q.odds) || (q.prevLine != null && q.prevLine !== q.line));
    if (moved) { state.changedAt.set(q.id, local); recordMove(q, local); }
    const pl = now - q.updatedAt; if (pl > -5000 && pl < 120000) { lat.pushLag[q.book]?.push(pl); lat.recent[q.book]?.push(pl); lat.at[q.book] = now; }
    if (q.book === 'draftkings' && q.sourceTs && moved) { const e2e = now - q.sourceTs; if (e2e > -5000 && e2e < 600000) { const ph = state.games.get(q.gameKey)?.status === 'live' ? 'live' : 'pregame'; lat.endToEnd.draftkings[ph].push(e2e); lat.recent.e2e.push(e2e); lat.at.e2e = now; if (!document.hidden) drawnTs.push(q.sourceTs); } }
  }
  for (const [book, s] of Object.entries(b.sources || {})) state.sources[book] = s;
  if (structural) theme.render();
  else { for (const k of touched) theme.renderGame(k); if ((b.quotes || []).length) theme.renderWire(); theme.renderFeeds(); theme.renderBanner(); }
  // drop the previous-price history 8 s later
  for (const k of touched) setTimeout(() => theme.renderGame(k), 8100);
  // drawn: the frame after this render is on screen (rAF runs before that paint; the task after it, once it is done).
  // A hidden tab queues frames until it is shown again, so anything that crossed a hide/show is thrown away.
  if (drawnTs.length) { const ts = drawnTs.splice(0); const v = visSeq; requestAnimationFrame(() => setTimeout(() => {
    if (v !== visSeq || document.hidden) return;
    const t = serverNow(); for (const x of ts) { const d = t - x; if (d > -5000 && d < 600000) { lat.drawn.push(d); lat.recent.drawn.push(d); } } lat.at.drawn = t;
  }, 0)); }
}
const drawnTs = []; let visSeq = 0;
document.addEventListener('visibilitychange', () => { visSeq++; drawnTs.length = 0; });
function recordMove(q, at) {
  const g = state.games.get(q.gameKey); if (!g) return;
  state.moves.unshift({ at, book: q.book, gameKey: q.gameKey, game: `${g.away.abbr} @ ${g.home.abbr}`, market: q.market, side: q.side,
    sideName: q.market === 'total' ? (q.side === 'over' ? 'Over' : 'Under') : (q.side === 'home' ? g.home.abbr : g.away.abbr),
    prevOdds: q.prevOdds, odds: q.odds, prevLine: q.prevLine, line: q.line });
  state.moves.length = Math.min(state.moves.length, 30);
  state.moveCount[q.book] = (state.moveCount[q.book] || 0) + 1;
}

// ---------- timers ----------
setInterval(() => theme.tick(), 250); // age labels and freshness bars
setInterval(async () => { // measured samples go to the server so /api/metrics holds true end-to-end numbers
  const body = { pushLag: { draftkings: lat.pushLag.draftkings.splice(0), fanduel: lat.pushLag.fanduel.splice(0) }, endToEnd: { draftkings: { pregame: lat.endToEnd.draftkings.pregame.splice(0), live: lat.endToEnd.draftkings.live.splice(0) } }, drawn: { draftkings: lat.drawn.splice(0) } };
  if (Object.values(body.pushLag).some((a) => a.length) || Object.values(body.endToEnd.draftkings).some((a) => a.length) || body.drawn.draftkings.length) fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  for (const k of ['draftkings', 'fanduel', 'e2e', 'drawn']) if (lat.recent[k].length > 500) lat.recent[k].splice(0, lat.recent[k].length - 500);
}, 30000);

mountTheme(THEMES.find((t) => t.id === settings.theme) || THEMES[0]);
connect();                       // the stream first: prices on screen as early as possible
syncClock().catch(() => {});     // the clock offset only refines the "x s ago" labels, so it runs alongside
loadExtrasSummary(); setInterval(loadExtrasSummary, 60_000);
setInterval(() => syncClock().catch(() => {}), 120000);
