// Theme: Grid — the engineering view. One dense table: every game is two rows (away / home); best price, DraftKings
// and FanDuel side by side; fair (no-vig) win chance, hold, EV and a 48 h sparkline per game; feed health, tightest
// markets and the wire in compact panels above. Like every theme it only draws: data and rules come from `api`.
const REPO = 'https://github.com/youngbizman/nfl-odds-board';
const MK = [['spread', 'Spread'], ['total', 'Total'], ['moneyline', 'ML']];
const BOOKS = ['draftkings', 'fanduel'];
const SIDES = { spread: ['away', 'home'], total: ['over', 'under'], moneyline: ['away', 'home'] };
const SHORT = { moneyline: 'ML', spread: 'SP', total: 'TOT' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const et = (d, o) => d.toLocaleString('en-US', { timeZone: 'America/Toronto', ...o });
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const sgnPct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`);
let api, root, el = {}, sort = 'time';

function mount(r, a) {
  api = a; root = r;
  const picker = api.themes.length > 1 ? `<label class="g-field">Design<select id="g-theme">${api.themes.map((t) => `<option value="${t.id}"${t.id === api.settings.theme ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : '';
  root.innerHTML = `
  <a class="skip" href="#g-table">Skip to prices</a>
  <div class="g-app">
    <header class="g-top">
      <div class="g-brand"><span class="g-logo" aria-hidden="true"></span><b>Odds Grid</b><span class="g-sub">NFL · Ontario · DraftKings × FanDuel · live</span></div>
      <label class="g-search"><span class="sr">Find a team</span><input id="g-search" type="search" autocomplete="off" placeholder="Search team   /"></label>
      <div class="g-seg" role="group" aria-label="View"><button type="button" data-view="best">Best</button><button type="button" data-view="draftkings">DraftKings</button><button type="button" data-view="fanduel">FanDuel</button></div>
      <div class="g-seg" role="group" aria-label="Show"><button type="button" data-phase="all">All</button><button type="button" data-phase="live">Live</button><button type="button" data-phase="pregame">Pregame</button><button type="button" data-phase="starred" title="Starred games">★</button></div>
      <label class="g-field">Odds<select id="g-format"><option value="american">American</option><option value="decimal">Decimal</option></select></label>
      ${picker}
      <div class="g-icons"><button type="button" class="g-icon" id="g-scheme" title="Light / dark (d)" aria-label="Switch light or dark"></button><button type="button" class="g-icon" id="g-help-btn" title="Keyboard (?)" aria-label="Keyboard shortcuts" aria-expanded="false">?</button><a class="g-icon" href="${REPO}#readme" title="How it works" aria-label="How it works">i</a></div>
    </header>
    <div class="g-help" id="g-help" hidden role="dialog" aria-label="Keyboard shortcuts"><b>Keyboard</b>
      <dl><dt>/</dt><dd>search</dd><dt>1 2 3</dt><dd>best · DraftKings · FanDuel</dd><dt>d</dt><dd>dark / light</dd><dt>s</dt><dd>star the focused game</dd><dt>Enter</dt><dd>chart the focused price</dd><dt>Esc</dt><dd>close</dd></dl></div>
    <div id="g-banner" class="g-banner" hidden></div>
    <section class="g-panels" aria-label="Status">
      <div class="g-panel"><h2>Feeds</h2><div id="g-feeds"></div></div>
      <div class="g-panel"><h2>Tightest markets <span class="g-hint">hold at the best price per side · below 0 = arbitrage</span></h2><div id="g-holds"></div></div>
      <div class="g-panel"><h2>Wire <span class="g-hint">latest moves</span></h2><div id="g-wire"></div></div>
    </section>
    <div class="g-meta" id="g-meta"></div>
    <div class="g-wrap"><table class="g-table" id="g-table"><thead></thead></table></div>
    <footer class="g-foot">Best = higher odds on the same line, open and fresh; equal = tie; different lines are never ranked. Win% and EV use the no-vig
      fair price from both books on the same line. Hold = the books' combined margin at the best price on each side; below 0 = arbitrage. Ontario prices; nothing simulated.
      <a href="${REPO}#readme">How it works ↗</a></footer>
  </div>`;
  el = { table: root.querySelector('#g-table'), feeds: root.querySelector('#g-feeds'), holds: root.querySelector('#g-holds'), wire: root.querySelector('#g-wire'),
    banner: root.querySelector('#g-banner'), meta: root.querySelector('#g-meta'), help: root.querySelector('#g-help') };
  root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => api.set('view', b.dataset.view)));
  root.querySelectorAll('[data-phase]').forEach((b) => b.addEventListener('click', () => api.set('phase', b.dataset.phase)));
  root.querySelector('#g-search').addEventListener('input', (e) => api.set('search', e.target.value));
  const f = root.querySelector('#g-format'); f.value = api.settings.format; f.addEventListener('change', (e) => api.set('format', e.target.value));
  root.querySelector('#g-theme')?.addEventListener('change', (e) => api.setTheme(e.target.value));
  root.querySelector('#g-scheme').addEventListener('click', () => api.set('scheme', document.documentElement.dataset.scheme === 'dark' ? 'light' : 'dark'));
  root.querySelector('#g-help-btn').addEventListener('click', () => toggleHelp());
  el.table.addEventListener('click', onTableClick);
  el.table.addEventListener('change', (e) => { if (e.target.matches('[data-x-both]')) api.setExtras(e.target.closest('[data-extras]').dataset.extras, { bothOnly: e.target.checked }); });
  el.table.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('td[data-market]')) { e.preventDefault(); onTableClick(e); } });
  el.holds.addEventListener('click', (e) => { const t = e.target.closest('[data-goto]'); if (t) goTo(t.dataset.goto, t.dataset.alt); });
}
function unmount() { root.innerHTML = ''; }
function focusSearch() { const i = root.querySelector('#g-search'); i.focus(); i.select(); }
function toggleHelp(force) { const open = force ?? el.help.hidden; el.help.hidden = !open; root.querySelector('#g-help-btn').setAttribute('aria-expanded', String(open)); }
function closeHelp() { if (el.help && !el.help.hidden) toggleHelp(false); }

function onTableClick(e) {
  const s = e.target.closest('[data-sort]'); if (s) { sort = sort === s.dataset.sort ? 'time' : s.dataset.sort; return render(); }
  const st = e.target.closest('[data-star]'); if (st) return api.toggleStar(st.dataset.star);
  const x = e.target.closest('[data-extras-toggle]'); if (x) return api.toggleExtras(x.dataset.extrasToggle);
  const k = e.target.closest('[data-x-kind]'); if (k) return api.setExtras(k.closest('[data-extras]').dataset.extras, { kind: k.dataset.xKind });
  const c = e.target.closest('td[data-market]'); const g = c?.closest('[data-game]');
  if (c && g) {
    api.pickChart(g.dataset.game, c.dataset.market, c.dataset.side);
    el.table.querySelector(`tbody[data-game="${CSS.escape(g.dataset.game)}"] td[data-market="${c.dataset.market}"][data-side="${c.dataset.side}"]`)?.focus({ preventScroll: true });
  }
}
function goTo(gk, alt) {
  if (!el.table.querySelector(`[data-game="${CSS.escape(gk)}"]`)) { api.set('phase', 'all'); api.set('search', ''); root.querySelector('#g-search').value = ''; }
  if (alt && !api.extrasOpen(gk)) api.toggleExtras(gk);
  if (alt) setTimeout(() => api.setExtras(gk, { kind: alt }), 400);
  requestAnimationFrame(() => { const n = el.table.querySelector(`[data-game="${CSS.escape(gk)}"]`); n?.scrollIntoView({ behavior: 'smooth', block: 'center' }); n?.classList.add('flag'); setTimeout(() => n?.classList.remove('flag'), 1600); });
}

// ---------- header ----------
const view = () => api.settings.view;
function colCount() { return 4 + (view() === 'best' ? 9 : 3) + 3; }
function head() {
  const V = view(); const B = api.BOOK;
  const bookHead = (b) => {
    const f = api.feedState(b); const L = api.latency(b);
    const st = f === 'live' ? (b === 'draftkings' ? `push${L.bookToScreenMs != null ? ` ${api.secs(L.bookToScreenMs)}` : ''}` : `poll ${api.secs(L.beatMs)}`) : f;
    return `<th colspan="3" class="g-grp g-${B[b].cls}${f !== 'live' ? ' is-down' : ''}">${B[b].label} <span class="g-st"><i></i>${esc(st)}</span></th>`;
  };
  const groups = V === 'best' ? `<th colspan="3" class="g-grp g-best">Best available</th>${bookHead('draftkings')}${bookHead('fanduel')}` : bookHead(V);
  const n = V === 'best' ? 3 : 1;
  const sub = Array.from({ length: n }, () => MK.map(([, l], i) => `<th class="g-mk${i === 0 ? ' g-first' : ''}">${l}</th>`).join('')).join('');
  const sortBtn = (id, label, title) => `<button type="button" data-sort="${id}" class="g-sort${sort === id ? ' on' : ''}" title="${title}">${label}${sort === id && id !== 'time' ? ' ▼' : ''}</button>`;
  return `<tr class="g-h1"><th rowspan="2" class="g-star-h"><span class="sr">Star</span></th><th rowspan="2" class="g-time-h">${sortBtn('time', 'Time', 'Sort by kickoff')}</th><th rowspan="2" class="g-team-h">Team</th><th rowspan="2" class="g-win-h" title="No-vig fair chance to win, from both books">Win%</th>
    ${groups}<th rowspan="2" class="g-hold-h">${sortBtn('hold', 'Hold', 'Tightest market first')}</th><th rowspan="2" class="g-ev-h">${sortBtn('ev', 'EV', 'Best expected value vs the no-vig price first')}</th><th rowspan="2" class="g-spark-h">48 h</th></tr>
    <tr class="g-h2">${sub}</tr>`;
}

// ---------- cells ----------
function moveMark(q) {
  const ch = api.change(q); if (!ch) return { cls: '', mark: '' };
  if (ch.lineMoved) return { cls: ' mv-line', mark: `<i class="mv line" title="line was ${esc(api.fmtLine(q.market, q.side, ch.prevLine))}">↔</i>` };
  if (!ch.dir) return { cls: '', mark: '' };
  return { cls: ch.flash ? ` fl-${ch.dir}` : '', mark: `<i class="mv ${ch.dir}" title="was ${esc(api.fmtOdds(ch.prevOdds))}">${ch.dir === 'up' ? '▲' : '▼'}</i>` };
}
const lineTxt = (market, side, q) => (market === 'moneyline' ? '' : `<span class="ln">${esc(market === 'total' ? `${side === 'over' ? 'o' : 'u'}${q.line}` : api.fmtLine(market, side, q.line))}</span>`);
function tdAttrs(g, market, side, extra = '') { const p = api.chartPick(g.key); return `data-market="${market}" data-side="${side}" tabindex="0"${p.market === market && p.side === side ? ' data-charted' : ''}${extra}`; }
function bestCell(g, market, side) {
  const { cmp } = api.both(g, market, side);
  const a = tdAttrs(g, market, side);
  if (cmp.kind === 'best' || cmp.kind === 'tie') {
    const q = cmp.best; const m = moveMark(q); const other = cmp.offers.find((o) => o.book !== q.book);
    const who = cmp.kind === 'tie' ? 'tie' : api.BOOK[q.book].short;
    const ed = cmp.kind === 'best' && other ? api.edge(q.odds, other.odds) : null;
    const edge = ed ? `<span class="ed" title="${esc(ed.title)}">${esc(ed.text)}</span>` : '';
    return `<td class="c-best ${cmp.kind === 'tie' ? 'tie' : `win-${api.BOOK[q.book].cls}`}${m.cls}" ${a}>${lineTxt(market, side, q)}<b class="od">${esc(api.fmtOdds(q.odds))}</b>${m.mark}<span class="bk">${who}</span>${edge}</td>`;
  }
  if (cmp.kind === 'partial') { const q = cmp.best; return `<td class="c-best partial" ${a} title="the only open, fresh offer">${lineTxt(market, side, q)}<b class="od">${esc(api.fmtOdds(q.odds))}</b><span class="bk">${api.BOOK[q.book].short} only</span></td>`; }
  if (cmp.kind === 'different') return `<td class="c-best diff" ${a} title="the books post different lines: see their columns; never ranked">≠ lines</td>`;
  return `<td class="c-best none" ${a}>—</td>`;
}
function bookCell(g, market, side, book) {
  const { cmp } = api.both(g, market, side); const q = api.quote(g.key, market, side, book);
  const a = tdAttrs(g, market, side, q ? ` data-q="${esc(`${q.gameKey}|${q.market}|${q.side}|${q.book}`)}" data-odds="${q.odds ?? ''}" data-line="${q.line ?? ''}"` : '');
  if (!q) return `<td class="c-bk none" ${a}>—</td>`;
  const down = api.bookDown(book);
  const win = view() === 'best' && ((cmp.kind === 'best' && cmp.best.book === book) || (cmp.kind === 'tie' && cmp.books.includes(book)));
  const m = moveMark(q);
  const cls = ['c-bk', q.suspended ? 'susp' : '', down ? 'stale' : '', win ? (cmp.kind === 'tie' ? 'tie' : 'win') : ''].filter(Boolean).join(' ');
  const tag = q.suspended ? '<span class="tag">susp</span>' : win && cmp.kind === 'best' ? '<span class="star">★</span>' : '';
  return `<td class="${cls}${m.cls}" ${a}>${lineTxt(market, side, q)}<b class="od">${esc(api.fmtOdds(q.odds))}</b>${m.mark}${tag}</td>`;
}
function spark(g) {
  const pick = api.chartPick(g.key); const S = api.series(g, pick.market, pick.side); const books = view() === 'best' ? BOOKS : [view()];
  const prob = (o) => 1 / api.decimalOdds(o);
  let lo = 1, hi = 0, moves = 0;
  for (const b of books) { moves += Math.max(0, S.books[b].length - 1); for (const p of S.books[b]) { const v = prob(p[1]); lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  if (hi < lo) return '<span class="g-nodata">—</span>';
  const mid = (lo + hi) / 2, half = Math.max(((hi - lo) / 2) * 1.2, 0.01); lo = mid - half; hi = mid + half;
  const span = Math.max(1, S.to - S.from);
  const X = (t) => ((Math.min(Math.max(t, S.from), S.to) - S.from) / span) * 100, Y = (v) => (1 - (v - lo) / (hi - lo)) * 100;
  const paths = books.map((b) => {
    const pts = S.books[b]; if (!pts.length) return '';
    let d = `M${X(pts[0][0]).toFixed(1)},${Y(prob(pts[0][1])).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += `H${X(pts[i][0]).toFixed(1)}V${Y(prob(pts[i][1])).toFixed(1)}`;
    return `<path class="s-${api.BOOK[b].cls}" d="${d}H100"/>`;
  }).join('');
  const side = pick.market === 'total' ? (pick.side === 'over' ? 'o' : 'u') : g[pick.side].abbr;
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${paths}</svg><span class="g-sp-l">${esc(side)} ${SHORT[pick.market]} · ${moves} mv</span>`;
}
function rowEV(g, side) {
  let best = null;
  for (const [m] of MK) {
    const s = m === 'total' ? (side === 'away' ? 'over' : 'under') : side;
    const f = api.fair(g, m, s);
    if (f.ev != null && (!best || f.ev > best.ev)) best = { ev: f.ev, m };
  }
  return best;
}
function countdown(t) {
  const s = (t - api.serverNow()) / 1000; if (s <= 0) return 'now';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function gameRows(g) {
  const V = view(); const live = g.status === 'live'; const star = api.isStarred(g.key);
  const holds = api.holds(g); const hs = MK.filter(([m]) => holds[m]);
  const minHold = hs.length ? Math.min(...hs.map(([m]) => holds[m].hold)) : null;
  const x = api.extrasCount(g.key); const open = api.extrasOpen(g.key);
  const start = new Date(g.start);
  const time = live ? '<span class="g-live">● LIVE</span>' : `<span class="g-t">${esc(et(start, { weekday: 'short' }))} ${esc(et(start, { hour: 'numeric', minute: '2-digit' }))}</span><span class="g-cd" data-countdown="${start.getTime()}">${esc(countdown(start.getTime()))}</span>`;
  const row = (idx) => {
    const sideTeam = idx === 0 ? 'away' : 'home'; const t = g[sideTeam];
    const f = api.fair(g, 'moneyline', sideTeam); const e = rowEV(g, sideTeam);
    const cells = (fn) => MK.map(([m]) => fn(m, SIDES[m][idx])).join('');
    const marketCells = V === 'best' ? cells((m, s) => bestCell(g, m, s)) + BOOKS.map((b) => cells((m, s) => bookCell(g, m, s, b))).join('') : cells((m, s) => bookCell(g, m, s, V));
    const lead = idx === 0 ? `<td rowspan="2" class="g-star"><button type="button" data-star="${esc(g.key)}" aria-pressed="${star}" title="${star ? 'Unstar' : 'Star'} (s)">${star ? '★' : '☆'}</button></td>
      <td rowspan="2" class="g-time">${time}${x || open ? `<button type="button" class="g-more" data-extras-toggle="${esc(g.key)}" aria-expanded="${open}" title="Alt lines and player props from both books">${open ? '▾' : '▸'} ${x ? `${x.both} more` : 'more'}</button>` : ''}</td>` : '';
    const holdCell = idx === 0 ? `<td rowspan="2" class="g-hold">${hs.map(([m]) => `<span class="${holds[m].hold < 0 ? 'arb' : holds[m].hold < 0.02 ? 'low' : ''}"><em>${SHORT[m]}</em>${pct(holds[m].hold)}</span>`).join('')}</td>` : '';
    const evCell = `<td class="g-ev${e && e.ev > 0 ? ' pos' : ''}" title="Best expected value on this row against the no-vig fair price">${e ? `${sgnPct(e.ev)}<em>${SHORT[e.m]}</em>` : '—'}</td>`;
    const sparkCell = idx === 0 ? `<td rowspan="2" class="g-spark">${spark(g)}</td>` : '';
    return `<tr class="${idx === 0 ? 'r-away' : 'r-home'}">${lead}<td class="g-team"><b>${esc(t.abbr)}</b><span>${esc(t.name)}</span></td><td class="g-win" title="Fair ${f.fair != null ? esc(api.fmtOdds(f.fair)) : '—'} from ${f.books} book${f.books === 1 ? '' : 's'}">${pct(f.p)}</td>${marketCells}${holdCell}${evCell}${sparkCell}</tr>`;
  };
  const xrow = open ? `<tr class="g-xrow"><td colspan="${colCount()}" data-extras="${esc(g.key)}">${extrasInner(g.key)}</td></tr>` : '';
  return `<tbody class="g-game${live ? ' is-live' : ''}${minHold != null && minHold < 0 ? ' is-arb' : ''}" data-game="${esc(g.key)}">${row(0)}${row(1)}${xrow}</tbody>`;
}

// ---------- More lines (alt lines + props) inside the table ----------
function extrasInner(gk) {
  const v = api.extrasView(gk); if (!v) return '';
  if (!v.loaded) return '<div class="g-x"><p class="g-note">Loading alt lines and props…</p></div>';
  if (!v.kinds.length) return '<div class="g-x"><p class="g-note">No alt lines or props up for this game yet.</p></div>';
  const tabs = v.kinds.map((k) => `<button type="button" data-x-kind="${k.id}" class="${k.id === v.kind ? 'on' : ''}" aria-pressed="${k.id === v.kind}">${esc(k.label)} <small>${v.bothOnly ? k.both : k.all}</small></button>`).join('');
  const cell = (o, cmp) => {
    if (!o) return '<td class="none">—</td>';
    const win = (cmp.kind === 'best' && cmp.best.book === o.book) || (cmp.kind === 'tie' && cmp.books.includes(o.book));
    const cls = [o.suspended ? 'susp' : '', win ? (cmp.kind === 'tie' ? 'tie' : 'win') : '', o.moved ? `fl-${o.moved}` : ''].filter(Boolean).join(' ');
    return `<td class="${cls}"><b class="od">${esc(api.fmtOdds(o.odds))}</b>${o.moved ? `<i class="mv ${o.moved}">${o.moved === 'up' ? '▲' : '▼'}</i>` : ''}${o.suspended ? '<span class="tag">susp</span>' : win && cmp.kind === 'best' ? '<span class="star">★</span>' : ''}</td>`;
  };
  const rows = v.rows.slice(0, 250).map((r) => `<tr><th>${esc(r.label)}</th>${r.cells.map((o) => cell(o, r.cmp)).join('')}</tr>`).join('');
  const body = v.rows.length
    ? `<div class="g-xscroll"><table class="g-xt"><thead><tr><th>${v.kind === 'alt-spread' || v.kind === 'alt-total' ? 'Line' : 'Player · threshold'}</th><th>DraftKings</th><th>FanDuel</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="g-note">No bet here that both books offer at the same number; untick "both books only" to see each book\'s own lines.</p>';
  return `<div class="g-x"><div class="g-xbar"><div class="g-xtabs">${tabs}</div><label><input type="checkbox" data-x-both ${v.bothOnly ? 'checked' : ''}> both books only</label></div>${body}</div>`;
}
function renderExtras(gk) {
  const td = el.table.querySelector(`td[data-extras="${CSS.escape(gk)}"]`);
  if (!td) return renderGame(gk);
  const top = td.querySelector('.g-xscroll')?.scrollTop || 0; td.innerHTML = extrasInner(gk);
  const sc = td.querySelector('.g-xscroll'); if (sc && top) sc.scrollTop = top;
}
function renderExtrasToggles() { for (const tb of el.table.querySelectorAll('tbody[data-game]')) renderGame(tb.dataset.game); }

// ---------- whole table ----------
function sortedGames() {
  if (sort === 'time') return null;
  const games = api.groups().flatMap((grp) => grp.games);
  if (sort === 'hold') { const h = (g) => { const x = api.holds(g); return Math.min(...['spread', 'total', 'moneyline'].map((m) => x[m]?.hold ?? 9)); }; return games.sort((a, b) => h(a) - h(b)); }
  const e = (g) => Math.max(rowEV(g, 'away')?.ev ?? -9, rowEV(g, 'home')?.ev ?? -9);
  return games.sort((a, b) => e(b) - e(a));
}
function render() {
  root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view())));
  root.querySelectorAll('[data-phase]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.phase === api.settings.phase)));
  root.querySelector('#g-scheme').textContent = document.documentElement.dataset.scheme === 'dark' ? '☀' : '☾';
  el.table.dataset.view = view();
  const groups = api.groups(); const total = groups.reduce((n, g) => n + g.games.length, 0); const live = groups.find((g) => g.live)?.games.length || 0;
  el.meta.innerHTML = `<span>${total} games · ${live} live · ${api.settings.format === 'decimal' ? 'decimal' : 'American'} odds${sort !== 'time' ? ` · sorted by ${sort === 'ev' ? 'EV' : 'hold'}` : ''}</span><span>click a price to chart it · ★ = best book · ¢ = edge over the other book</span>`;
  const thead = el.table.querySelector('thead'); thead.innerHTML = head();
  for (const tb of [...el.table.querySelectorAll('tbody')]) tb.remove();
  let html;
  if (!api.state.everConnected) html = `<tbody><tr><td colspan="${colCount()}" class="g-empty">Connecting to both books…</td></tr></tbody>`;
  else if (!total) html = `<tbody><tr><td colspan="${colCount()}" class="g-empty">No games match. Clear the search or choose All.</td></tr></tbody>`;
  else {
    const flat = sortedGames();
    html = flat ? flat.map(gameRows).join('') : groups.map((grp) => {
      const label = grp.starred ? '★ STARRED' : grp.live ? '● LIVE' : `${esc(et(grp.start, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase())} · ${esc(et(grp.start, { hour: 'numeric', minute: '2-digit' }))} ET <span class="g-cd" data-countdown="${grp.start.getTime()}">${esc(countdown(grp.start.getTime()))}</span>`;
      return `<tbody class="g-sep"><tr><td colspan="${colCount()}">${label}<span class="g-n">${grp.games.length} ${grp.games.length === 1 ? 'game' : 'games'}</span></td></tr></tbody>${grp.games.map(gameRows).join('')}`;
    }).join('');
  }
  thead.insertAdjacentHTML('afterend', html);
  renderFeeds(); renderBanner(); renderWire(); renderHolds();
}
function renderGame(key) {
  const g = api.state.games.get(key); const node = el.table.querySelector(`tbody[data-game="${CSS.escape(key)}"]`);
  if (!g || !node) return;
  const top = node.querySelector('.g-xscroll')?.scrollTop || 0;
  node.insertAdjacentHTML('afterend', gameRows(g)); node.remove();
  const sc = el.table.querySelector(`tbody[data-game="${CSS.escape(key)}"] .g-xscroll`); if (sc && top) sc.scrollTop = top;
}

// ---------- panels ----------
function renderFeeds() {
  const rows = BOOKS.map((b) => {
    const s = api.state.sources[b] || {}; const f = api.feedState(b); const L = api.latency(b); const fr = api.freshness(b);
    const lat = f !== 'live' ? '—' : b === 'draftkings' ? (L.bookToScreenMs != null ? `${api.secs(L.bookToScreenMs)}${L.clockPm != null ? ` ±${L.clockPm}ms` : ''}` : 'on next move') : `≤ ${api.secs(L.maxAgeMs)}`;
    return `<tr class="f-${f}"><th>${api.BOOK[b].label}</th><td><i class="dot"></i>${esc(f)}</td><td>${b === 'draftkings' ? 'ws push' : `poll ${api.secs(L.beatMs)}${L.interleave ? ' · 2 IPs' : ''}`}</td>
      <td data-age-ts="${s.lastDataAt || ''}">${esc(api.ago(s.lastDataAt))}</td><td>${esc(lat)}</td><td><span class="bar"><i data-fresh="${b}" style="width:${(fr.fill * 100).toFixed(0)}%"></i></span></td></tr>`;
  }).join('');
  el.feeds.innerHTML = `<table class="g-pt g-feedt"><thead><tr><th></th><th>state</th><th>mode</th><th>data</th><th>latency</th><th>fresh</th></tr></thead><tbody>${rows}
    <tr class="f-${api.state.connected ? 'live' : 'lost'}"><th>Stream</th><td><i class="dot"></i>${api.state.connected ? 'open' : 'reconnecting'}</td><td>SSE</td><td colspan="3">${esc(api.state.sources.draftkings?.region || 'Ontario')} · clock ±${api.state.rtt != null ? Math.round(api.state.rtt / 2) : '—'} ms</td></tr></tbody></table>`;
}
function renderBanner() {
  const st = api.state; const b = el.banner;
  const set = (cls, txt) => { b.hidden = false; b.className = `g-banner ${cls}`; b.setAttribute('role', cls === 'info' ? 'status' : 'alert'); b.innerHTML = txt; };
  if (!st.everConnected) return set('info', '<b>Connecting…</b> waiting for the first snapshot.');
  if (!st.connected) return set('bad', '<b>Connection lost · reconnecting.</b> Prices shown are from before the drop and are greyed out.');
  const down = BOOKS.filter((x) => !['live', 'connecting'].includes(api.feedState(x)));
  if (down.length) return set('warn', `<b>${down.map((x) => api.BOOK[x].label).join(' and ')} ${down.length > 1 ? 'are' : 'is'} stale.</b> Those prices are greyed and cannot win.`);
  b.hidden = true;
}
function renderWire() {
  const moves = api.state.moves.slice(0, 6);
  el.wire.innerHTML = moves.length ? `<table class="g-pt">${moves.map((m) => {
    const lm = m.prevLine != null && m.prevLine !== m.line;
    const fmt = (l, o) => `${lm ? `${api.fmtLine(m.market, m.side, l)} ` : ''}${api.fmtOdds(o)}`;
    return `<tr><td class="mut" data-age-local="${m.at}">${esc(api.ago(m.at, Date.now()))}</td><th>${esc(m.game.replace(' @ ', '@'))}</th><td>${esc(m.sideName)} ${SHORT[m.market]}</td><td class="mono">${esc(fmt(m.prevLine, m.prevOdds))} → <b>${esc(fmt(m.line, m.odds))}</b></td><td>${api.BOOK[m.book].short}</td></tr>`;
  }).join('')}</table>` : '<p class="g-note">No moves since this page opened. Lines are quiet midweek; Sundays and live games move constantly.</p>';
}
function renderHolds() {
  const main = api.tightest(6).map((t) => ({ ...t, alt: null }));
  const alt = (api.state.extrasHolds || []).slice(0, 3).map((t) => ({ game: api.state.games.get(t.gameKey), market: t.kind === 'alt-spread' ? 'spread' : 'total', hold: t.hold, a: { ...t.a, side: t.a.subject }, b: { ...t.b, side: t.b.subject }, alt: t.kind })).filter((t) => t.game);
  const items = [...main, ...alt].sort((a, b) => a.hold - b.hold).slice(0, 6);
  const leg = (g, m, o) => `${m === 'total' ? `${o.side === 'over' ? 'o' : 'u'}${o.line}` : `${g[o.side]?.abbr ?? ''}${m === 'spread' ? ` ${api.fmtLine('spread', o.side, o.line)}` : ''}`} <b>${esc(api.fmtOdds(o.odds))}</b> <span class="mut">${api.BOOK[o.book].short}</span>`;
  const html = items.length ? `<table class="g-pt g-holdt">${items.map((t) => `<tr class="${t.hold < 0 ? 'arb' : ''}" data-goto="${esc(t.game.key)}"${t.alt ? ` data-alt="${t.alt}"` : ''} title="Jump to the game"><th>${esc(t.game.away.abbr)}@${esc(t.game.home.abbr)}</th><td>${t.alt ? (t.alt === 'alt-spread' ? 'alt SP' : 'alt TOT') : SHORT[t.market]}</td><td class="mono">${leg(t.game, t.market, t.a)} / ${leg(t.game, t.market, t.b)}</td><td class="h">${t.hold < 0 ? 'ARB ' : ''}${pct(t.hold)}</td></tr>`).join('')}</table>` : '<p class="g-note">Waiting for prices.</p>';
  if (html !== renderHolds.last) { renderHolds.last = html; el.holds.innerHTML = html; }
}
function tick() {
  for (const n of root.querySelectorAll('[data-age-ts]')) n.textContent = api.ago(Number(n.dataset.ageTs) || null);
  for (const n of root.querySelectorAll('[data-age-local]')) n.textContent = api.ago(Number(n.dataset.ageLocal), Date.now());
  for (const n of root.querySelectorAll('[data-countdown]')) n.textContent = countdown(Number(n.dataset.countdown));
  for (const n of root.querySelectorAll('[data-fresh]')) n.style.width = `${(api.freshness(n.dataset.fresh).fill * 100).toFixed(0)}%`;
  if ((tick.n = (tick.n || 0) + 1) % 8 === 0) renderHolds();
  const sig = BOOKS.map(api.feedState).join('|') + api.state.connected;
  if (sig !== tick.sig) { tick.sig = sig; render(); }
}

export default { id: 'grid', name: 'Grid (engineering)', css: '/themes/grid.css',
  fonts: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap',
  mount, unmount, render, renderGame, renderFeeds, renderBanner, renderWire, renderExtras, renderExtrasToggles, renderHolds, focusSearch, toggleHelp, closeHelp, tick };
