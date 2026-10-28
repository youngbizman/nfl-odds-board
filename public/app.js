// Board UI: one SSE connection, local copy of games + quotes, render on change, measure latency.
const BOOK_LABEL = { draftkings: 'DraftKings', fanduel: 'FanDuel' };
const BOOK_CLS = { draftkings: 'dk', fanduel: 'fd' };
const state = { view: 'best', games: new Map(), quotes: new Map(), sources: {}, offset: 0, rtt: null, connected: false };
const lat = { pushLag: { draftkings: [], fanduel: [] }, endToEnd: { draftkings: { pregame: [], live: [] } }, recent: { draftkings: [], fanduel: [], e2e: { pregame: [], live: [] } } };
const $ = (s) => document.querySelector(s);
const rows = $('#rows');

// ---------- clock offset (browser clock vs server clock), NTP-style: offset = serverTs - midpoint ----------
async function syncClock() {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.timeOrigin + performance.now();
    const r = await fetch('/api/time', { cache: 'no-store' }); const { serverTs } = await r.json();
    const t1 = performance.timeOrigin + performance.now();
    const rtt = t1 - t0, off = serverTs - (t0 + t1) / 2;
    if (!best || rtt < best.rtt) best = { rtt, off };
  }
  state.offset = best.off; state.rtt = best.rtt;
}
const serverNow = () => Date.now() + state.offset;

// ---------- SSE ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => { const s = JSON.parse(e.data); applySnapshot(s); state.connected = true; conn(); });
  es.addEventListener('batch', (e) => { const b = JSON.parse(e.data); applyBatch(b); });
  es.onerror = () => { state.connected = false; conn(); }; // EventSource reconnects by itself (retry: 2000)
}
function conn() {
  const el = $('#conn');
  el.textContent = state.connected ? `connected · live updates on · ${state.quotes.size} prices · ${state.games.size} games` : 'reconnecting to server…';
  el.className = 'conn' + (state.connected ? '' : ' bad');
}
function applySnapshot(s) {
  state.games = new Map(s.games.map((g) => [g.key, g]));
  state.quotes = new Map(s.quotes.map((q) => [q.id, q]));
  state.sources = s.sources;
  renderAll(); renderStatus(); renderLatency();
}
function applyBatch(b) {
  const now = serverNow();
  for (const g of b.games) state.games.set(g.key, { ...(state.games.get(g.key) || {}), ...g });
  const touched = new Set();
  for (const q of b.quotes) {
    if (q.removed) state.quotes.delete(q.id); else state.quotes.set(q.id, { ...q, _flashAt: Date.now() });
    touched.add(q.gameKey);
    // push lag: server stamped updatedAt when it learned the price; we are painting it now
    const pl = now - q.updatedAt; if (Number.isFinite(pl) && pl > -5000 && pl < 120000) { lat.pushLag[q.book]?.push(pl); lat.recent[q.book]?.push(pl); }
    if (q.book === 'draftkings' && q.sourceTs) { // end to end: DraftKings' own publish time → this paint
      const e2e = now - q.sourceTs; const phase = state.games.get(q.gameKey)?.status === 'live' ? 'live' : 'pregame';
      if (e2e > -5000 && e2e < 600000) { lat.endToEnd.draftkings[phase].push(e2e); lat.recent.e2e[phase].push(e2e); }
    }
  }
  for (const [book, s] of Object.entries(b.sources || {})) state.sources[book] = s;
  if (b.games.length && !touched.size) renderAll(); else for (const k of touched) renderGame(k);
  if (b.games.length) for (const g of b.games) renderGame(g.key);
  renderStatus(); renderLatency();
}

// ---------- rendering ----------
const fmtOdds = (a) => a == null ? '—' : a > 0 ? `+${a}` : `${a}`;
const fmtLine = (m, side, l) => l == null ? '' : m === 'total' ? `${side === 'over' ? 'O' : 'U'} ${l}` : (l > 0 ? `+${l}` : `${l}`);
const quoteOf = (gk, m, side, book) => state.quotes.get(`${gk}|${m}|${side}|${book}`);
const isStale = (book) => !!state.sources[book]?.stale;

function bestOf(quotes) {
  const live = quotes.filter((q) => q && q.odds != null && !q.suspended);
  if (!live.length) return null;
  const lines = new Set(live.map((q) => q.line ?? 'ml'));
  const sorted = live.slice().sort((a, b) => b.odds - a.odds);
  if (lines.size > 1) return { conflict: true, offers: sorted };
  return { conflict: false, best: sorted[0], books: sorted.filter((q) => q.odds === sorted[0].odds).map((q) => q.book) };
}

function offerHtml(q, { book, bookLabel, tag } = {}) {
  if (!q) return `<div class="offer empty">—</div>`;
  const b = book || q.book;
  const flash = q._flashAt && Date.now() - q._flashAt < 1500 ? (q.prevOdds != null && q.odds != null ? (q.odds > q.prevOdds ? ' flash-up' : q.odds < q.prevOdds ? ' flash-down' : ' flash-up') : ' flash-up') : '';
  const showPrev = q._flashAt && Date.now() - q._flashAt < 6000 && (q.prevOdds != null || q.prevLine != null) && (q.prevOdds !== q.odds || q.prevLine !== q.line);
  const prev = showPrev ? `<span class="prev">${q.prevLine != null && q.prevLine !== q.line ? fmtLine(q.market, q.side, q.prevLine) + ' ' : ''}${fmtOdds(q.prevOdds)}</span>` : '';
  const cls = ['offer', BOOK_CLS[b] || 'both', flash, isStale(q.book) ? 'stale' : '', q.suspended ? 'suspended' : ''].join(' ');
  return `<div class="${cls}" title="${BOOK_LABEL[q.book]} · updated ${new Date(q.updatedAt).toLocaleTimeString()}">
    <span class="num"><span class="line">${fmtLine(q.market, q.side, q.line)}</span></span>
    <span class="num">${prev}<span class="odds">${fmtOdds(q.odds)}</span></span>
    ${tag ? `<span class="tag">${tag}</span>` : ''}<span class="book">${bookLabel || BOOK_LABEL[q.book]}</span></div>`;
}

function cellHtml(gk, market, sides) {
  return `<div class="cell">${sides.map((side) => {
    if (state.view !== 'best') return offerHtml(quoteOf(gk, market, side, state.view));
    const dk = quoteOf(gk, market, side, 'draftkings'), fd = quoteOf(gk, market, side, 'fanduel');
    const best = bestOf([dk, fd]);
    if (!best) return offerHtml(dk || fd); // whatever exists, maybe suspended
    if (best.conflict) return `<div class="split">${best.offers.map((q) => offerHtml(q, { tag: 'lines differ' })).join('')}</div>`;
    const label = best.books.length > 1 ? 'DK = FD' : BOOK_LABEL[best.best.book];
    return offerHtml(best.best, { book: best.books.length > 1 ? 'both' : best.best.book, bookLabel: label });
  }).join('')}</div>`;
}

function gameHtml(g) {
  const start = new Date(g.start);
  const when = g.status === 'live' ? '<span class="live">LIVE</span>' : start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const books = ['draftkings', 'fanduel'].filter((b) => g.books?.[b]).map((b) => BOOK_CLS[b].toUpperCase()).join(' · ');
  return `<td class="game"><div class="teams">
      <div class="team"><span class="abbr">${g.away.abbr}</span>${g.away.name}</div>
      <div class="team"><span class="abbr">${g.home.abbr}</span>${g.home.name}</div></div>
      <div class="meta">${when}<span>·</span><span title="books offering this game">${books}</span></div></td>
    <td>${cellHtml(g.key, 'spread', ['away', 'home'])}</td>
    <td>${cellHtml(g.key, 'total', ['over', 'under'])}</td>
    <td>${cellHtml(g.key, 'moneyline', ['away', 'home'])}</td>`;
}

function orderedGames() {
  return [...state.games.values()].filter((g) => [...state.quotes.values()].some((q) => q.gameKey === g.key))
    .sort((a, b) => (a.status === 'live' ? 0 : 1) - (b.status === 'live' ? 0 : 1) || new Date(a.start) - new Date(b.start) || a.key.localeCompare(b.key));
}
function renderAll() {
  const games = orderedGames();
  rows.innerHTML = games.map((g) => `<tr data-key="${g.key}">${gameHtml(g)}</tr>`).join('');
  $('#empty').hidden = games.length > 0;
}
function renderGame(key) {
  const g = state.games.get(key); const tr = rows.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
  if (!g) { tr?.remove(); return; }
  if (!tr) return renderAll();
  tr.innerHTML = gameHtml(g);
}
function ago(ts) { if (!ts) return 'never'; const s = Math.max(0, Math.round((serverNow() - ts) / 1000)); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; }
function renderStatus() {
  $('#status').innerHTML = Object.values(state.sources).map((s) => {
    const cls = s.stale ? 'stale' : s.state === 'down' ? 'down' : '';
    const mode = s.mode === 'websocket' ? 'push' : s.mode === 'poll' ? 'poll' : s.mode ? s.mode.replace('websocket', 'push').replace(' (via edge)', ' · edge') : '';
    return `<div class="pill ${BOOK_CLS[s.book]} ${cls}" title="${(s.detail || '') + (s.lastError ? ' · last error: ' + s.lastError : '')}"><span class="dot"></span><b>${BOOK_LABEL[s.book]}</b><small>${mode} · ${s.stale ? 'STALE' : s.state} · data ${ago(s.lastDataAt)}</small></div>`;
  }).join('');
}
const p = (arr, q) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const ms = (v) => v == null ? '—' : `${Math.round(v)} ms`;
function renderLatency() {
  const dk = state.sources.draftkings || {}, fd = state.sources.fanduel || {};
  const r = lat.recent;
  $('#latencyBody').innerHTML = `
  <div class="card dk"><h4>DraftKings · WebSocket push</h4><dl>
    <dt>book → your screen (pregame)</dt><dd>p50 ${ms(p(r.e2e.pregame, .5))} · p95 ${ms(p(r.e2e.pregame, .95))} · n=${r.e2e.pregame.length}</dd>
    <dt>book → your screen (live)</dt><dd>p50 ${ms(p(r.e2e.live, .5))} · p95 ${ms(p(r.e2e.live, .95))} · n=${r.e2e.live.length}</dd>
    <dt>server → your screen</dt><dd>p50 ${ms(p(r.draftkings, .5))} · n=${r.draftkings.length}</dd>
    <dt>last price change</dt><dd>${ago(dk.lastChangeAt)}</dd><dt>last snapshot</dt><dd>${ago(dk.lastSnapshotAt)}</dd></dl></div>
  <div class="card fd"><h4>FanDuel · polling</h4><dl>
    <dt>how old can a number be</dt><dd>≤ poll interval + request time (see pill)</dd>
    <dt>server → your screen</dt><dd>p50 ${ms(p(r.fanduel, .5))} · n=${r.fanduel.length}</dd>
    <dt>last poll</dt><dd>${ago(fd.lastDataAt)}</dd><dt>last price change</dt><dd>${ago(fd.lastChangeAt)}</dd><dt>detail</dt><dd>${fd.detail || ''}</dd></dl></div>
  <div class="card"><h4>This browser</h4><dl><dt>clock offset vs server</dt><dd>${Math.round(state.offset)} ms (rtt ${ms(state.rtt)})</dd><dt>view</dt><dd>${state.view}</dd></dl></div>`;
}

// ---------- toggle, timers, reporting ----------
document.querySelectorAll('.toggle button').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view; document.querySelectorAll('.toggle button').forEach((x) => x.classList.toggle('on', x === b)); renderAll(); renderLatency();
}));
setInterval(() => { renderStatus(); }, 1000);
setInterval(async () => { // send measured samples to the server so /api/metrics has true end-to-end numbers
  const body = { pushLag: { draftkings: lat.pushLag.draftkings.splice(0), fanduel: lat.pushLag.fanduel.splice(0) }, endToEnd: { draftkings: { pregame: lat.endToEnd.draftkings.pregame.splice(0), live: lat.endToEnd.draftkings.live.splice(0) } } };
  if (Object.values(body.pushLag).some((a) => a.length) || Object.values(body.endToEnd.draftkings).some((a) => a.length)) fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}, 30000);
syncClock().finally(connect);
setInterval(syncClock, 120000);
