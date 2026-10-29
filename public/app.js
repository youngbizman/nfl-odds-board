// Board core: one SSE connection, local copy of games + quotes, filters/settings, latency measurement.
// Everything visual lives in a theme (public/themes/*.js + .css). Themes only draw; the rules live here and in
// /lib/model.js (the same file the server tests check), so switching design can never change what is shown.
import { compare, decimalOdds } from '/lib/model.js';
import pressbox from '/themes/pressbox.js';

const THEMES = [pressbox]; // add a second design here and a "Design" picker appears in every theme

const BOOK = { draftkings: { label: 'DraftKings', short: 'DK', cls: 'dk' }, fanduel: { label: 'FanDuel', short: 'FD', cls: 'fd' } };
const MARKETS = [['spread', ['away', 'home']], ['total', ['over', 'under']], ['moneyline', ['away', 'home']]];
const keep = { get(k, d) { try { return localStorage.getItem(`board.${k}`) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(`board.${k}`, v); } catch {} } };
const qs = new URLSearchParams(location.search);

const settings = {
  view: qs.get('view') || 'best',                                   // best | draftkings | fanduel (?view= is shareable)
  phase: 'all',                                                     // all | live | pregame
  search: '',
  format: keep.get('format', 'american'),                           // american | decimal
  theme: qs.get('theme') || keep.get('theme', THEMES[0].id),
};
const state = { games: new Map(), quotes: new Map(), sources: {}, config: { staleMs: { draftkings: 75000, fanduel: 10000 } },
  offset: 0, rtt: null, connected: false, everConnected: false, moves: [], changedAt: new Map() };
const lat = { pushLag: { draftkings: [], fanduel: [] }, endToEnd: { draftkings: { pregame: [], live: [] } }, recent: { draftkings: [], fanduel: [], e2e: [] } };

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
const bookDown = (book) => { const s = state.sources[book]; return !s || s.stale || s.state === 'down' || !state.connected; };
const feedState = (book) => { const s = state.sources[book] || {}; if (!state.connected && state.everConnected) return 'lost'; if (s.state === 'down') return 'reconnecting'; if (s.stale) return 'stale'; if (s.state === 'connecting' || !s.lastDataAt) return 'connecting'; return 'live'; };

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

function phaseOf(g) { return g.status === 'live' ? 'live' : 'pregame'; }
function visibleGames() {
  const withPrices = new Set([...state.quotes.values()].map((q) => q.gameKey));
  const term = settings.search.trim().toLowerCase();
  return [...state.games.values()]
    .filter((g) => withPrices.has(g.key))
    .filter((g) => settings.phase === 'all' || phaseOf(g) === settings.phase)
    .filter((g) => !term || [g.away.abbr, g.home.abbr, g.away.name, g.home.name, g.away.nick, g.home.nick].some((x) => String(x || '').toLowerCase().includes(term)))
    .sort((a, b) => (phaseOf(a) === 'live' ? 0 : 1) - (phaseOf(b) === 'live' ? 0 : 1) || new Date(a.start) - new Date(b.start) || a.key.localeCompare(b.key));
}
function groups() {
  const out = new Map();
  for (const g of visibleGames()) {
    const k = phaseOf(g) === 'live' ? 'live' : g.start;
    if (!out.has(k)) out.set(k, { key: k, live: k === 'live', start: k === 'live' ? null : new Date(g.start), games: [] });
    out.get(k).games.push(g);
  }
  return [...out.values()];
}
function latency(book) {
  const s = state.sources[book] || {};
  if (book === 'draftkings') {
    const e2e = pct(lat.recent.e2e, 0.5);
    return { measured: e2e != null, bookToScreenMs: e2e ?? (s.lagP50Ms != null ? s.lagP50Ms + (pct(lat.recent.draftkings, 0.5) ?? 30) : null), bookToServerMs: s.lagP50Ms ?? null, samples: lat.recent.e2e.length || s.lagCount || 0, clockPm: s.clockUncertaintyMs ?? null };
  }
  const beat = (s.pollMs || 1000) / (s.interleave ? 2 : 1);
  return { beatMs: beat, freshMs: s.freshP50Ms ?? beat, maxAgeMs: beat + (s.lastPollMs || 0) + (pct(lat.recent.fanduel, 0.5) ?? 30), interleave: !!s.interleave };
}
function freshness(book, now = serverNow()) {
  const s = state.sources[book] || {}; const limit = state.config.staleMs?.[book] || 60000;
  const age = s.lastDataAt ? now - s.lastDataAt : limit;
  return { age, fill: Math.max(0, Math.min(1, 1 - age / limit)) };
}

const api = { BOOK, MARKETS, state, settings, themes: THEMES, fmtOdds, fmtLine, ago, secs, serverNow, quote, cell, change, groups, visibleGames, phaseOf,
  feedState, latency, freshness, bookDown,
  set(key, value) { settings[key] = value; if (key === 'format') keep.set('format', value); if (key === 'view') { const u = new URL(location.href); value === 'best' ? u.searchParams.delete('view') : u.searchParams.set('view', value); history.replaceState(null, '', u); } theme.render(); },
  setTheme(id) { const t = THEMES.find((x) => x.id === id); if (!t || t === theme) return; keep.set('theme', id); settings.theme = id; mountTheme(t); },
};

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
    const t0 = Date.now(); const { serverTs } = await (await fetch('/api/time', { cache: 'no-store' })).json(); const t1 = Date.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, off: serverTs - (t0 + t1) / 2 };
  }
  state.offset = best.off; state.rtt = best.rtt;
}
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => {
    const s = JSON.parse(e.data);
    state.games = new Map(s.games.map((g) => [g.key, g])); state.quotes = new Map(s.quotes.map((q) => [q.id, q]));
    state.sources = s.sources; if (s.config) state.config = s.config;
    state.connected = true; state.everConnected = true;
    theme.render();
  });
  es.addEventListener('batch', (e) => applyBatch(JSON.parse(e.data)));
  es.addEventListener('beat', (e) => { for (const [b, [d, c]] of Object.entries(JSON.parse(e.data))) { const s = state.sources[b]; if (s) { s.lastDataAt = d; s.lastChangeAt = c; } } theme.renderFeeds(); });
  es.onerror = () => { state.connected = false; theme.renderBanner(); theme.renderFeeds(); }; // EventSource reconnects by itself; a fresh snapshot follows
}
function applyBatch(b) {
  const now = serverNow(), local = Date.now(); const touched = new Set(); let structural = false;
  for (const g of b.games || []) { const prev = state.games.get(g.key); if (!prev || prev.status !== g.status) structural = true; state.games.set(g.key, { ...(prev || {}), ...g }); touched.add(g.key); }
  for (const q of b.quotes || []) {
    touched.add(q.gameKey);
    if (q.removed) { state.quotes.delete(q.id); structural = true; continue; }
    if (!state.quotes.has(q.id)) structural = true;
    state.quotes.set(q.id, q);
    const moved = (q.prevOdds != null && q.prevOdds !== q.odds) || (q.prevLine != null && q.prevLine !== q.line);
    if (moved) { state.changedAt.set(q.id, local); recordMove(q, local); }
    const pl = now - q.updatedAt; if (pl > -5000 && pl < 120000) { lat.pushLag[q.book]?.push(pl); lat.recent[q.book]?.push(pl); }
    if (q.book === 'draftkings' && q.sourceTs && moved) { const e2e = now - q.sourceTs; if (e2e > -5000 && e2e < 600000) { const ph = state.games.get(q.gameKey)?.status === 'live' ? 'live' : 'pregame'; lat.endToEnd.draftkings[ph].push(e2e); lat.recent.e2e.push(e2e); } }
  }
  for (const [book, s] of Object.entries(b.sources || {})) state.sources[book] = s;
  if (structural) theme.render();
  else { for (const k of touched) theme.renderGame(k); if ((b.quotes || []).length) theme.renderWire(); theme.renderFeeds(); theme.renderBanner(); }
  // drop the previous-price history 8 s later
  for (const k of touched) setTimeout(() => theme.renderGame(k), 8100);
}
function recordMove(q, at) {
  const g = state.games.get(q.gameKey); if (!g) return;
  state.moves.unshift({ at, book: q.book, gameKey: q.gameKey, game: `${g.away.abbr} @ ${g.home.abbr}`, market: q.market, side: q.side,
    sideName: q.market === 'total' ? (q.side === 'over' ? 'Over' : 'Under') : (q.side === 'home' ? g.home.abbr : g.away.abbr),
    prevOdds: q.prevOdds, odds: q.odds, prevLine: q.prevLine, line: q.line });
  state.moves.length = Math.min(state.moves.length, 30);
}

// ---------- timers ----------
setInterval(() => theme.tick(), 250); // age labels and freshness bars
setInterval(async () => { // measured samples go to the server so /api/metrics holds true end-to-end numbers
  const body = { pushLag: { draftkings: lat.pushLag.draftkings.splice(0), fanduel: lat.pushLag.fanduel.splice(0) }, endToEnd: { draftkings: { pregame: lat.endToEnd.draftkings.pregame.splice(0), live: lat.endToEnd.draftkings.live.splice(0) } } };
  if (Object.values(body.pushLag).some((a) => a.length) || Object.values(body.endToEnd.draftkings).some((a) => a.length)) fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  for (const k of ['draftkings', 'fanduel', 'e2e']) if (lat.recent[k].length > 500) lat.recent[k].splice(0, lat.recent[k].length - 500);
}, 30000);

mountTheme(THEMES.find((t) => t.id === settings.theme) || THEMES[0]);
syncClock().catch(() => {}).finally(connect);
setInterval(() => syncClock().catch(() => {}), 120000);
