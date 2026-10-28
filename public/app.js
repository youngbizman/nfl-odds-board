// Board UI: one SSE connection, a local copy of games + quotes, surgical re-rendering, and latency measurement.
const BOOK = { draftkings: { label: 'DraftKings', short: 'DK', cls: 'dk' }, fanduel: { label: 'FanDuel', short: 'FD', cls: 'fd' } };
const MARKET_LABEL = { spread: 'spread', total: 'total', moneyline: 'moneyline' };
const state = { view: 'best', games: new Map(), quotes: new Map(), sources: {}, config: { staleMs: { draftkings: 150000, fanduel: 15000 } }, offset: 0, rtt: null, connected: false, everConnected: false, moves: [] };
const lat = { pushLag: { draftkings: [], fanduel: [] }, endToEnd: { draftkings: { pregame: [], live: [] } }, recent: { draftkings: [], fanduel: [], e2e: { pregame: [], live: [] } } };
const $ = (s) => document.querySelector(s);
const boardEl = $('#board'), feedsEl = $('#feeds'), tapeEl = $('#tape'), bannerEl = $('#banner');
const flashTimers = new Map();

// ---------- clock offset (browser vs server), NTP-style ----------
async function syncClock() {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now(); const { serverTs } = await (await fetch('/api/time', { cache: 'no-store' })).json(); const t1 = Date.now();
    const rtt = t1 - t0, off = serverTs - (t0 + t1) / 2;
    if (!best || rtt < best.rtt) best = { rtt, off };
  }
  state.offset = best.off; state.rtt = best.rtt;
}
const serverNow = () => Date.now() + state.offset;

// ---------- live stream ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => { applySnapshot(JSON.parse(e.data)); state.connected = true; state.everConnected = true; renderBanner(); });
  es.addEventListener('batch', (e) => applyBatch(JSON.parse(e.data)));
  es.onerror = () => { state.connected = false; renderBanner(); }; // EventSource reconnects by itself and we get a fresh snapshot
}
function applySnapshot(s) {
  state.games = new Map(s.games.map((g) => [g.key, g]));
  state.quotes = new Map(s.quotes.map((q) => [q.id, q]));
  state.sources = s.sources; if (s.config) state.config = s.config;
  renderBoard(); renderFeeds(); renderTape();
}
function applyBatch(b) {
  const now = serverNow();
  const touched = new Set();
  for (const g of b.games || []) { state.games.set(g.key, { ...(state.games.get(g.key) || {}), ...g }); touched.add(g.key); }
  for (const q of b.quotes || []) {
    touched.add(q.gameKey);
    if (q.removed) { state.quotes.delete(q.id); continue; }
    state.quotes.set(q.id, { ...q, _flashAt: Date.now() });
    if (q.prevOdds != null || q.prevLine != null) recordMove(q);
    const pl = now - q.updatedAt; if (pl > -5000 && pl < 120000) { lat.pushLag[q.book]?.push(pl); lat.recent[q.book]?.push(pl); }
    if (q.book === 'draftkings' && q.sourceTs) { const e2e = now - q.sourceTs; const phase = state.games.get(q.gameKey)?.status === 'live' ? 'live' : 'pregame'; if (e2e > -5000 && e2e < 600000) { lat.endToEnd.draftkings[phase].push(e2e); lat.recent.e2e[phase].push(e2e); } }
  }
  for (const [book, s] of Object.entries(b.sources || {})) state.sources[book] = s;
  // a game appearing/disappearing or changing slot re-lays the board; price moves patch one row
  const structural = (b.games || []).some((g) => !boardEl.querySelector(`[data-key="${CSS.escape(g.key)}"]`) || g.status !== undefined);
  if (structural) renderBoard(); else for (const k of touched) renderGame(k);
  if (b.quotes?.length) renderTape();
  renderFeeds();
}

// ---------- formatting ----------
const fmtOdds = (a) => a == null ? '—' : a > 0 ? `+${a}` : `${a}`.replace('-', '−');
const fmtLine = (m, side, l) => l == null ? '' : m === 'total' ? `${side === 'over' ? 'O' : 'U'} ${l}` : (l > 0 ? `+${l}` : `${l}`.replace('-', '−'));
const quoteOf = (gk, m, side, book) => state.quotes.get(`${gk}|${m}|${side}|${book}`);
const isStale = (book) => !!state.sources[book]?.stale;
function ago(ts, now = serverNow()) {
  if (!ts) return 'never'; const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}
const pct = (arr, q) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const secs = (ms) => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
function sideName(g, market, side) { return market === 'total' ? (side === 'over' ? 'Over' : 'Under') : (side === 'home' ? g?.home.abbr : g?.away.abbr); }

// ---------- best price ----------
function bestOf(quotes) {
  const live = quotes.filter((q) => q && q.odds != null && !q.suspended);
  if (!live.length) return null;
  const lines = new Set(live.map((q) => q.line ?? 'ml'));
  const sorted = live.slice().sort((a, b) => b.odds - a.odds);
  if (lines.size > 1) return { conflict: true, offers: sorted };
  return { conflict: false, best: sorted[0], books: sorted.filter((q) => q.odds === sorted[0].odds).map((q) => q.book), offers: sorted };
}

// ---------- cells ----------
function cellHtml(q, { chip, other, age } = {}) {
  if (!q) return `<div class="cell empty">no line</div>`;
  const t = Date.now() - (q._flashAt || 0);
  const moved = q._flashAt && t < 8000 && (q.prevOdds != null || q.prevLine != null) && (q.prevOdds !== q.odds || q.prevLine !== q.line);
  const dir = moved && q.prevOdds != null && q.odds != null ? (q.odds > q.prevOdds ? 'up' : q.odds < q.prevOdds ? 'down' : '') : '';
  const flash = q._flashAt && t < 1500 ? (dir === 'down' ? ' flash-down' : ' flash-up') : '';
  const prev = moved ? `<s>${q.prevLine != null && q.prevLine !== q.line ? fmtLine(q.market, q.side, q.prevLine) + ' ' : ''}${fmtOdds(q.prevOdds)}</s>` : '';
  const arrow = dir ? `<span class="arrow ${dir}">${dir === 'up' ? '▲' : '▼'}</span>` : '';
  const cls = ['cell', chip === 'both' ? 'both' : BOOK[q.book].cls, flash, isStale(q.book) ? 'stale' : '', q.suspended ? 'suspended' : ''].join(' ');
  const chipText = chip === 'both' ? 'DK = FD' : chip ? BOOK[chip].label : '';
  const sub = chipText || other || age ? `<span class="sub"><span class="chip">${chipText || ''}</span><span class="other">${other || ''}${age ? `<span class="age" data-ts="${q.updatedAt}">updated ${ago(q.updatedAt)}</span>` : ''}</span></span>` : '';
  return `<div class="${cls}" data-q="${q.gameKey}|${q.market}|${q.side}|${q.book}" data-odds="${q.odds ?? ''}" data-line="${q.line ?? ''}" title="${BOOK[q.book].label}, updated ${new Date(q.updatedAt).toLocaleTimeString()}${q.suspended ? ', suspended' : ''}">
    <span class="line">${fmtLine(q.market, q.side, q.line)}</span><span class="odds">${prev}<b>${fmtOdds(q.odds)}</b>${arrow}</span>${sub}</div>`;
}
function marketHtml(g, market, sides) {
  return `<div class="market" data-label="${market === 'moneyline' ? 'Moneyline' : market === 'spread' ? 'Spread' : 'Total'}">${sides.map((side) => {
    if (state.view !== 'best') return cellHtml(quoteOf(g.key, market, side, state.view), { age: true });
    const dk = quoteOf(g.key, market, side, 'draftkings'), fd = quoteOf(g.key, market, side, 'fanduel');
    const best = bestOf([dk, fd]);
    if (!best) return cellHtml(dk || fd, { chip: (dk || fd)?.book });
    if (best.conflict) return `<div class="split"><span class="note">lines differ</span>${best.offers.map((q) => cellHtml(q, { chip: q.book })).join('')}</div>`;
    const tie = best.books.length > 1;
    const runnerUp = tie ? null : best.offers.find((q) => q.book !== best.best.book) || [dk, fd].find((q) => q && q.book !== best.best.book);
    const other = runnerUp ? `${BOOK[runnerUp.book].short} ${runnerUp.suspended ? 'suspended' : fmtOdds(runnerUp.odds)}` : (tie ? '' : `${BOOK[best.best.book === 'draftkings' ? 'fanduel' : 'draftkings'].short} no line`);
    return cellHtml(best.best, { chip: tie ? 'both' : best.best.book, other });
  }).join('')}</div>`;
}
function gameHtml(g) {
  const start = new Date(g.start);
  const mins = Math.round((start - Date.now()) / 60000);
  const when = g.status === 'live' ? `<span class="live-pill">Live</span><span>in progress</span>`
    : mins <= 0 ? 'kickoff passed' : mins < 60 ? `kicks off in ${mins} min` : mins < 48 * 60 ? `kicks off in ${Math.round(mins / 60)} h` : `kicks off in ${Math.round(mins / 1440)} days`;
  return `<div class="teams">
      <div class="team" style="--tc:${g.away.color || '#44506a'}"><span class="abbr">${g.away.abbr}</span><span class="name">${g.away.name}</span></div>
      <div class="team" style="--tc:${g.home.color || '#44506a'}"><span class="abbr">${g.home.abbr}</span><span class="name">${g.home.name}</span></div>
      <div class="kick">${when}</div></div>
    ${marketHtml(g, 'spread', ['away', 'home'])}${marketHtml(g, 'total', ['over', 'under'])}${marketHtml(g, 'moneyline', ['away', 'home'])}`;
}

// ---------- board ----------
function slotOf(g) {
  if (g.status === 'live') return { key: '0-live', label: 'Live now', live: true };
  const d = new Date(g.start);
  return { key: '1-' + d.toISOString(), label: d.toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric' }) + ' at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) };
}
function visibleGames() {
  const withPrices = new Set([...state.quotes.values()].map((q) => q.gameKey));
  return [...state.games.values()].filter((g) => withPrices.has(g.key)).sort((a, b) => (a.status === 'live' ? 0 : 1) - (b.status === 'live' ? 0 : 1) || new Date(a.start) - new Date(b.start) || a.key.localeCompare(b.key));
}
function renderBoard() {
  const games = visibleGames();
  if (!games.length) { boardEl.innerHTML = `<p class="empty-board">No NFL game lines right now. The board fills itself as soon as either book posts one.</p>`; return; }
  const slots = new Map();
  for (const g of games) { const s = slotOf(g); if (!slots.has(s.key)) slots.set(s.key, { ...s, games: [] }); slots.get(s.key).games.push(g); }
  boardEl.innerHTML = [...slots.values()].map((s) => `<section class="slot">
      <h2>${s.live ? '<span class="live-dot"></span>' : ''}${s.label}<small>${s.games.length} ${s.games.length === 1 ? 'game' : 'games'}</small></h2>
      <div class="cols"><span>Game</span><span>Spread</span><span>Total</span><span>Moneyline</span></div>
      ${s.games.map((g) => `<article class="game${g.status === 'live' ? ' live' : ''}" data-key="${g.key}">${gameHtml(g)}</article>`).join('')}
    </section>`).join('');
}
function renderGame(key) {
  const g = state.games.get(key); const el = boardEl.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!g) { el?.remove(); return; }
  if (!el) return renderBoard();
  el.innerHTML = gameHtml(g); el.classList.toggle('live', g.status === 'live');
  clearTimeout(flashTimers.get(key)); flashTimers.set(key, setTimeout(() => { const e = boardEl.querySelector(`[data-key="${CSS.escape(key)}"]`); if (e) e.innerHTML = gameHtml(g); }, 8300));
}

// ---------- moves tape ----------
function recordMove(q) {
  const g = state.games.get(q.gameKey);
  state.moves.unshift({ ts: Date.now(), who: `${sideName(g, q.market, q.side)} ${MARKET_LABEL[q.market]}`, market: q.market, side: q.side, book: q.book, prevOdds: q.prevOdds, prevLine: q.prevLine, odds: q.odds, line: q.line });
  state.moves.length = Math.min(state.moves.length, 40);
}
function renderTape() {
  if (!state.moves.length) return;
  tapeEl.innerHTML = state.moves.map((m) => {
    const lineMoved = m.prevLine != null && m.prevLine !== m.line;
    const dir = m.prevOdds != null && m.odds != null && !lineMoved ? (m.odds > m.prevOdds ? 'up' : m.odds < m.prevOdds ? 'down' : '') : '';
    const from = `${lineMoved ? fmtLine(m.market, m.side, m.prevLine) + ' ' : ''}${fmtOdds(m.prevOdds)}`;
    const to = `${fmtLine(m.market, m.side, m.line)} ${fmtOdds(m.odds)}`;
    return `<span class="move ${dir}${Date.now() - m.ts < 5000 ? ' fresh' : ''}"><span class="who">${m.who}</span><s>${from}</s><span class="to">${to}</span><span class="bk ${BOOK[m.book].cls}">${BOOK[m.book].short}</span><time data-ts="${m.ts}">${ago(m.ts, Date.now())}</time></span>`;
  }).join('');
}

// ---------- feeds (freshness + latency per book) ----------
function renderFeeds() {
  const now = serverNow();
  feedsEl.innerHTML = ['draftkings', 'fanduel'].map((b) => {
    const s = state.sources[b] || {}; const B = BOOK[b];
    const threshold = state.config.staleMs?.[b] || 60000;
    const age = s.lastDataAt ? now - s.lastDataAt : threshold;
    const fill = Math.max(0, Math.min(1, 1 - age / threshold));
    const barColor = s.stale || s.state === 'down' ? 'var(--down)' : fill < .35 ? 'var(--best)' : 'var(--up)';
    const mode = b === 'draftkings' ? (s.mode?.includes('edge') ? 'push via Ontario relay' : 'push over WebSocket') : `polled every ${s.pollMs ? (s.pollMs >= 1000 ? (s.pollMs / 1000).toFixed(s.pollMs % 1000 ? 1 : 0) + ' s' : s.pollMs + ' ms') : '1 s'}`;
    const stateText = s.stale ? 'stale' : s.state === 'down' ? 'down, reconnecting' : s.state === 'connecting' ? 'connecting' : 'live';
    const r = lat.recent;
    const relay = b === 'draftkings' && s.relayRttMs != null ? `<span>Relay <b>${Math.round(s.relayRttMs / 2)} ms</b></span>` : '';
    const latency = b === 'draftkings'
      ? (r.e2e.pregame.length + r.e2e.live.length ? `<span>Book to screen <b>${secs(pct(r.e2e.pregame.concat(r.e2e.live), .5))}</b> over ${r.e2e.pregame.length + r.e2e.live.length} moves</span>` : `<span>Book to screen <b>measuring</b> on the next move</span>`)
      : `<span>Any number is at most <b>${secs((s.pollMs || 1000) + (s.lastPollMs || 0))}</b> old</span>`;
    return `<div class="feed ${B.cls}${s.stale ? ' stale' : ''}${s.state === 'down' ? ' down' : ''}" title="${(s.detail || '') + (s.lastError ? '. Last error: ' + s.lastError : '')}">
      <div class="feed-head"><b>${B.label}</b><span class="mode">${s.region ? s.region + ' · ' : ''}${mode}</span><span class="state">${stateText}</span></div>
      <div class="feed-bar"><i style="width:${(fill * 100).toFixed(0)}%;background:${barColor}"></i></div>
      <div class="feed-meta"><span>Data <b>${ago(s.lastDataAt, now)}</b></span><span>Last move <b>${ago(s.lastChangeAt, now)}</b></span>${latency}${relay}${r[b].length ? `<span>Server to screen <b>${secs(pct(r[b], .5))}</b></span>` : ''}</div></div>`;
  }).join('');
}
function renderBanner() {
  const stale = ['draftkings', 'fanduel'].filter((b) => state.sources[b]?.stale);
  if (!state.connected && state.everConnected) { bannerEl.hidden = false; bannerEl.className = 'banner'; bannerEl.textContent = 'Lost the connection to the server. Reconnecting; prices on screen are from before the drop.'; return; }
  if (stale.length) { bannerEl.hidden = false; bannerEl.className = 'banner'; bannerEl.textContent = `${stale.map((b) => BOOK[b].label).join(' and ')} ${stale.length > 1 ? 'have' : 'has'} stopped answering. Those prices are greyed out and may be old; the other book keeps updating.`; return; }
  const regions = ['draftkings', 'fanduel'].map((b) => state.sources[b]?.region).filter(Boolean);
  if (regions.length === 2 && regions[0] !== regions[1]) { bannerEl.hidden = false; bannerEl.className = 'banner info'; bannerEl.textContent = `Heads up: DraftKings prices are from ${regions[0]} and FanDuel prices from ${regions[1]}. Books can price differently by jurisdiction.`; return; }
  bannerEl.hidden = true;
}

// ---------- view toggle, timers, reporting ----------
document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view; document.querySelectorAll('.views button').forEach((x) => x.setAttribute('aria-selected', String(x === b))); renderBoard();
}));
setInterval(() => { // once a second: freshness bars, ages, stale greying, banner
  renderFeeds(); renderBanner();
  const now = Date.now(); for (const t of tapeEl.querySelectorAll('time')) t.textContent = ago(Number(t.dataset.ts), now);
  for (const a of boardEl.querySelectorAll('.age')) a.textContent = `updated ${ago(Number(a.dataset.ts))}`;
  for (const b of ['draftkings', 'fanduel']) for (const c of boardEl.querySelectorAll(`.cell.${BOOK[b].cls}`)) c.classList.toggle('stale', isStale(b));
}, 1000);
setInterval(async () => { // send measured samples to the server so /api/metrics holds true end-to-end numbers
  const body = { pushLag: { draftkings: lat.pushLag.draftkings.splice(0), fanduel: lat.pushLag.fanduel.splice(0) }, endToEnd: { draftkings: { pregame: lat.endToEnd.draftkings.pregame.splice(0), live: lat.endToEnd.draftkings.live.splice(0) } } };
  if (Object.values(body.pushLag).some((a) => a.length) || Object.values(body.endToEnd.draftkings).some((a) => a.length)) fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}, 30000);
// ?view=draftkings | fanduel | best — shareable links to one book's board
{ const v = new URLSearchParams(location.search).get('view'); const btn = v && document.querySelector(`.views button[data-view="${v}"]`); if (btn) btn.click(); }
syncClock().finally(connect);
setInterval(syncClock, 120000);
