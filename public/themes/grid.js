// Theme: Grid — the engineering view. One dense table: every game is two rows (away / home); best price, DraftKings
// and FanDuel side by side; fair (no-vig) win chance, hold, EV and a 48 h sparkline per game; feed health, tightest
// markets and the wire in compact panels above. Like every theme it only draws: data and rules come from `api`.
const REPO = 'https://github.com/youngbizman/nfl-odds-board';
const MK = [['spread', 'Spread'], ['total', 'Total'], ['moneyline', 'ML']];
const BOOKS = ['draftkings', 'fanduel'];
const SIDES = { spread: ['away', 'home'], total: ['over', 'under'], moneyline: ['away', 'home'] };
const SHORT = { moneyline: 'ML', spread: 'SP', total: 'TOT' };
import { bigChart, ladderChart, chartHover } from '/charts.js';
import { topbarHtml, wireTopbar, renderTopbar, footerHtml } from '/topbar.js';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const et = (d, o) => d.toLocaleString('en-US', { timeZone: 'America/Toronto', ...o });
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const sgnPct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`);
let api, root, el = {}, sort = 'time';

function mount(r, a) {
  api = a; root = r;
  root.innerHTML = `
  <a class="skip" href="#g-table">Skip to prices</a>
  <div class="g-app">
    ${topbarHtml(api, REPO)}
    <div class="g-help" id="g-help" hidden role="dialog" aria-label="Keyboard shortcuts"><b>Keyboard</b>
      <dl><dt>/</dt><dd>search</dd><dt>1 2 3</dt><dd>best · DraftKings · FanDuel</dd><dt>d</dt><dd>dark / light</dd><dt>s</dt><dd>star the focused game</dd><dt>Enter</dt><dd>chart the focused price</dd><dt>Esc</dt><dd>close</dd></dl></div>
    <div id="g-banner" class="g-banner" hidden></div>
    <section class="g-feeds-panel" aria-label="Feeds"><h2>Feeds <span class="g-hint">live health of both books and of this page's stream</span><button type="button" class="g-link g-feeds-more" id="g-feeds-more" aria-expanded="false">▾ details</button></h2><div id="g-feeds"></div></section>
    <section class="g-panels" aria-label="Status">
      <div class="g-panel"><h2>Tightest markets <span class="g-hint" id="g-holds-scope"></span></h2><p class="g-explain">Margin = what the books keep if you bet both sides at the best prices. Lower is better for you; below 0% the two prices together pay back more than you stake (a possible arbitrage).</p><div id="g-holds"></div></div>
      <div class="g-panel"><h2>Wire <span class="g-hint">latest moves</span></h2><div id="g-wire"></div></div>
    </section>
    <div class="g-pagebar" id="g-page" hidden></div>
    <div class="g-meta" id="g-meta"></div>
    <div class="g-wrap"><table class="g-table" id="g-table"><thead></thead></table></div>
    <div class="g-big" id="g-big"></div>
    ${footerHtml(REPO, { winEv: true })}
  </div>`;
  el = { table: root.querySelector('#g-table'), feeds: root.querySelector('#g-feeds'), holds: root.querySelector('#g-holds'), wire: root.querySelector('#g-wire'),
    banner: root.querySelector('#g-banner'), meta: root.querySelector('#g-meta'), help: root.querySelector('#g-help'), page: root.querySelector('#g-page'), big: root.querySelector('#g-big') };
  wireTopbar(root, api, { toggleHelp });
  el.meta.addEventListener('click', (e) => { if (e.target.closest('[data-singles]')) api.set('singleBook', !api.settings.singleBook); });
  el.page.addEventListener('click', (e) => { if (e.target.closest('[data-back]') && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); api.closeGame(); } });
  chartHover(el.big, api); chartHover(el.table, api);
  el.big.addEventListener('click', (e) => {
    const rg = e.target.closest('[data-range]'); if (rg) return api.setRange(rg.dataset.range);
    const pk = e.target.closest('[data-pick]'); if (pk && api.settings.game) { const [m, sd] = pk.dataset.pick.split('|'); api.pickChart(api.settings.game, m, sd); }
  });
  el.table.addEventListener('click', onTableClick);
  el.table.addEventListener('change', (e) => {
    if (e.target.matches('[data-x-both]')) api.setExtras(e.target.closest('[data-extras]').dataset.extras, { bothOnly: e.target.checked });
    if (e.target.matches('[data-ladder-select]')) api.setExtras(e.target.closest('[data-extras]').dataset.extras, { ladder: e.target.value });
  });
  el.table.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('td[data-market], td[data-open-game]')) { e.preventDefault(); onTableClick(e); } });
  // feeds: state, last heard, last snapshot and freshness at first sight; "details" shows mode, latency and counts
  root.querySelector('#g-feeds-more').addEventListener('click', (e) => {
    const p = e.currentTarget.closest('.g-feeds-panel'); const open = !p.classList.contains('is-open');
    p.classList.toggle('is-open', open); e.currentTarget.setAttribute('aria-expanded', String(open)); e.currentTarget.textContent = open ? '▴ less' : '▾ details';
  });
  el.holds.addEventListener('click', (e) => { if (e.target.closest('[data-holds-more]')) { api.state.holdsMore = !api.state.holdsMore; return renderHolds(); } const t = e.target.closest('[data-goto]'); if (t) goTo(t.dataset.goto, t.dataset.alt); });
}
function unmount() { root.innerHTML = ''; }
function focusSearch() { const i = root.querySelector('#tb-search'); i.focus(); i.select(); }
function toggleHelp(force) { const open = force ?? el.help.hidden; el.help.hidden = !open; root.querySelector('#tb-help').setAttribute('aria-expanded', String(open)); }
function closeHelp() { if (el.help && !el.help.hidden) toggleHelp(false); }

let theadObs = null;
function onTableClick(e) {
  if (e.target.closest('[data-clear-search]')) { root.querySelector('#tb-search').value = ''; return api.set('search', ''); }
  const og = e.target.closest('[data-open-game]'); if (og) { if (og.tagName === 'A' && (e.metaKey || e.ctrlKey || e.shiftKey)) return; e.preventDefault(); return api.openGame(og.dataset.openGame); }
  const ld = e.target.closest('[data-ladder]'); if (ld) return api.setExtras(ld.closest('[data-extras]').dataset.extras, { ladder: ld.dataset.ladder });
  const s = e.target.closest('[data-sort]'); if (s) { sort = sort === s.dataset.sort ? 'time' : s.dataset.sort; return render(); }
  const st = e.target.closest('[data-star]'); if (st) return api.toggleStar(st.dataset.star);
  const x = e.target.closest('[data-extras-toggle]'); if (x) return api.toggleExtras(x.dataset.extrasToggle);
  const k = e.target.closest('[data-x-kind]'); if (k) return api.setExtras(k.closest('[data-extras]').dataset.extras, { kind: k.dataset.xKind, showAll: false });
  const xa = e.target.closest('[data-x-all]'); if (xa) return api.setExtras(xa.closest('[data-extras]').dataset.extras, { showAll: xa.dataset.xAll === '1' });
  const c = e.target.closest('td[data-market]'); const g = c?.closest('[data-game]');
  if (c && g) {
    api.pickChart(g.dataset.game, c.dataset.market, c.dataset.side);
    el.table.querySelector(`tbody[data-game="${CSS.escape(g.dataset.game)}"] td[data-market="${c.dataset.market}"][data-side="${c.dataset.side}"]`)?.focus({ preventScroll: true });
  }
}
function goTo(gk, alt) {
  if (!el.table.querySelector(`[data-game="${CSS.escape(gk)}"]`)) { api.set('phase', 'all'); api.set('search', ''); root.querySelector('#tb-search').value = ''; }
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
    const st = f === 'live' ? (b === 'draftkings' || L.push ? `push${L.page ? ` ${api.secs(L.page.p50)}` : ''}` : `poll ${api.secs(L.beatMs)}`) : f;
    return `<th colspan="3" class="g-grp g-${B[b].cls}${f !== 'live' ? ' is-down' : ''}">${B[b].label} <span class="g-st"><i></i>${esc(st)}</span></th>`;
  };
  const groups = V === 'best' ? `<th colspan="3" class="g-grp g-best">Best available</th>${bookHead('draftkings')}${bookHead('fanduel')}` : bookHead(V);
  const n = V === 'best' ? 3 : 1;
  const grp = V === 'best' ? ['best', 'bk', 'bk'] : ['bk'];
  const sub = Array.from({ length: n }, (_, gi) => MK.map(([, l], i) => `<th class="g-mk gs-${grp[gi]}${i === 0 ? ' g-first' : ''}">${l}</th>`).join('')).join('');
  const sortBtn = (id, label, title) => `<button type="button" data-sort="${id}" class="g-sort${sort === id ? ' on' : ''}" title="${title}">${label}${sort === id && id !== 'time' ? ' ▼' : ''}</button>`;
  return `<tr class="g-h1"><th rowspan="2" class="g-star-h"><span class="sr">Star</span></th><th rowspan="2" class="g-time-h">${sortBtn('time', 'Time', 'Sort by kickoff')}</th><th rowspan="2" class="g-team-h">Team</th><th rowspan="2" class="g-win-h" title="No-vig fair chance to win, from both books">Win%</th>
    ${groups}<th rowspan="2" class="g-hold-h">${sortBtn('hold', 'Hold', 'Tightest market first')}</th><th rowspan="2" class="g-ev-h">${sortBtn('ev', 'EV', 'Best expected value vs the no-vig price first')}</th><th rowspan="2" class="g-spark-h">48 h</th></tr>
    <tr class="g-h2">${sub}</tr>`;
}

// ---------- cells ----------
// a moved price: a quick flash, then for 8 s a thick green/red bar and a tag with the old price, so a move is noticed
function moveMark(q) {
  const ch = api.change(q); if (!ch) return { cls: '', mark: '' };
  if (ch.lineMoved) return { cls: ` mv-line${ch.flash ? ' fl-line' : ''}`, mark: `<i class="mv line" title="line was ${esc(api.fmtLine(q.market, q.side, ch.prevLine))}">↔</i><s class="was line">${esc(api.fmtLine(q.market, q.side, ch.prevLine))}</s>` };
  if (!ch.dir) return { cls: '', mark: '' };
  return { cls: ` mv-${ch.dir}${ch.flash ? ` fl-${ch.dir}` : ''}`, mark: `<i class="mv ${ch.dir}" title="was ${esc(api.fmtOdds(ch.prevOdds))}">${ch.dir === 'up' ? '▲' : '▼'}</i><s class="was ${ch.dir}" aria-label="was ${esc(api.fmtOdds(ch.prevOdds))}">${esc(api.fmtOdds(ch.prevOdds))}</s>` };
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
  if (cmp.kind === 'partial') { const q = cmp.best; return `<td class="c-best partial" ${a} title="the only open, fresh offer">${lineTxt(market, side, q)}<b class="od">${esc(api.fmtOdds(q.odds))}</b><span class="bk">${api.BOOK[q.book].short}<span class="bk-only"> only</span></span></td>`; }
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
  const mid = (lo + hi) / 2, half = Math.max(((hi - lo) / 2) * 1.2, 0.025); lo = mid - half; hi = mid + half; // ≥ 5 points of chance
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
const gameHref = (g) => api.gameHref(g); // /nfl/cardinals-at-cowboys-2026-11-01
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
      <td rowspan="2" class="g-time">${time}${x || open ? `<button type="button" class="g-more" data-extras-toggle="${esc(g.key)}" aria-expanded="${open}" title="${open ? 'Hide the alt lines and props' : 'Alt lines and player props from both books'}">${open ? '▾ hide lines' : `▸ ${x ? `${x.both} more` : 'more'}`}</button>` : ''}</td>` : '';
    const holdCell = idx === 0 ? `<td rowspan="2" class="g-hold">${hs.map(([m]) => `<span class="${holds[m].hold < 0 ? 'arb' : holds[m].hold < 0.02 ? 'low' : ''}"><em>${SHORT[m]}</em>${pct(holds[m].hold)}</span>`).join('')}</td>` : '';
    const evCell = `<td class="g-ev${e && e.ev > 0 ? ' pos' : ''}" title="Best expected value on this row against the no-vig fair price">${e ? `${sgnPct(e.ev)}<em>${SHORT[e.m]}</em>` : '—'}</td>`;
    const sparkCell = idx === 0 ? `<td rowspan="2" class="g-spark"${api.settings.game ? '' : ` data-open-game="${esc(g.key)}" tabindex="0" title="Click to enlarge: this game's page, 10 min to 1 week"`}>${spark(g)}</td>` : '';
    const teamTxt = `<b>${esc(t.abbr)}</b>${t.nick ? `<span>${esc(t.name)}</span>` : ''}`;
    const team = api.settings.game ? teamTxt : `<a href="${esc(gameHref(g))}" data-open-game="${esc(g.key)}" title="Open this game: big chart, every line">${teamTxt}</a>`;
    return `<tr class="${idx === 0 ? 'r-away' : 'r-home'}">${lead}<td class="g-team${t.nick ? '' : ' is-school'}">${team}</td><td class="g-win" title="Fair ${f.fair != null ? esc(api.fmtOdds(f.fair)) : '—'} from ${f.books} book${f.books === 1 ? '' : 's'}">${pct(f.p)}</td>${marketCells}${holdCell}${evCell}${sparkCell}</tr>`;
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
    const cls = [o.suspended ? 'susp' : '', o.stale ? 'stale' : '', win ? (cmp.kind === 'tie' ? 'tie' : 'win') : '', o.moved ? `fl-${o.moved}` : ''].filter(Boolean).join(' ');
    return `<td class="${cls}"><b class="od">${esc(api.fmtOdds(o.odds))}</b>${o.moved ? `<i class="mv ${o.moved}">${o.moved === 'up' ? '▲' : '▼'}</i>` : ''}${o.suspended ? '<span class="tag">susp</span>' : win && cmp.kind === 'best' ? '<span class="star">★</span>' : ''}</td>`;
  };
  const x = api.state.extras.get(gk) || {}; const N = x.showAll ? 250 : 20;
  const rows = v.rows.slice(0, N).map((r) => `<tr><th>${esc(r.label)}</th>${r.cells.map((o) => cell(o, r.cmp)).join('')}</tr>`).join('');
  const body = v.rows.length
    ? `<div class="g-xbody"><div class="g-xscroll"><table class="g-xt"><thead><tr><th>${v.kind === 'alt-spread' || v.kind === 'alt-total' ? 'Line' : 'Player · threshold'}</th><th>DraftKings</th><th>FanDuel</th></tr></thead><tbody>${rows}</tbody></table>${v.rows.length > 20 ? `<button type="button" class="g-xmore" data-x-all="${x.showAll ? 0 : 1}">${x.showAll ? 'show fewer' : `show all ${Math.min(250, v.rows.length)} lines`}</button>` : ''}</div>${ladderChart(api, gk, v)}</div>`
    : '<p class="g-note">No bet here that both books offer at the same number; untick "both books only" to see each book\'s own lines.</p>';
  return `<div class="g-x"><div class="g-xbar"><div class="g-xtabs">${tabs}</div><label><input type="checkbox" data-x-both ${v.bothOnly ? 'checked' : ''}> both books only</label><button type="button" class="g-xclose" data-extras-toggle="${esc(gk)}" aria-label="Close more lines">✕ close</button></div>${body}</div>`;
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
  renderTopbar(root, api);
  const pg = api.game(); root.querySelector('.g-app').classList.toggle('on-gamepage', !!api.settings.game);
  el.page.hidden = !api.settings.game;
  el.page.innerHTML = api.settings.game ? `<a class="g-back" href="${esc(api.boardHref())}" data-back>‹ All games</a><b>${pg ? `${esc(pg.away.name)} @ ${esc(pg.home.name)}` : 'This game is not on the board any more'}</b>${pg ? `<span class="mut">${pg.status === 'live' ? '● live' : esc(et(new Date(pg.start), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET')}<span class="g-esc"> · Esc to go back</span></span>` : ''}` : '';
  el.big.innerHTML = pg ? bigChart(api, pg, { pick: api.chartPick(pg.key), range: api.settings.range }) : '';
  el.table.dataset.view = view();
  const groups = api.groups(); const total = groups.reduce((n, g) => n + g.games.length, 0); const live = groups.filter((g) => g.live).reduce((n, g) => n + g.games.length, 0);
  const hidden = api.hiddenSingles();
  const singles = hidden ? ` · <button type="button" class="g-link" data-singles>+${hidden} priced by one book only</button>` : api.settings.league !== 'nfl' && api.settings.singleBook ? ' · <button type="button" class="g-link" data-singles>hide single-book games</button>' : '';
  el.meta.innerHTML = `<span>${total} ${total === 1 ? 'game' : 'games'} · ${live} live · ${api.settings.format === 'decimal' ? 'decimal' : 'American'} odds${sort !== 'time' ? ` · sorted by ${sort === 'ev' ? 'EV' : 'hold'}` : ''}${singles}</span><span>click a price to chart it · ★ = best book<span class="g-ed-key"> · ¢ = edge over the other book</span></span>`;
  const thead = el.table.querySelector('thead'); thead.innerHTML = head();
  // the alt-lines table's header sticks just under this one
  if (!theadObs) { try { theadObs = new ResizeObserver(() => document.documentElement.style.setProperty('--g-head-h', `${thead.offsetHeight}px`)); theadObs.observe(thead); } catch {} }
  document.documentElement.style.setProperty('--g-head-h', `${thead.offsetHeight}px`);
  for (const tb of [...el.table.querySelectorAll('tbody')]) tb.remove();
  let html;
  if (!api.state.everConnected) html = `<tbody><tr><td colspan="${colCount()}" class="g-empty">Connecting to both books…</td></tr></tbody>`;
  else if (!total) { const m = api.emptyMessage(); html = `<tbody><tr><td colspan="${colCount()}" class="g-empty"><b>${esc(m.title)}</b> ${esc(m.detail)}${m.clear ? ' <button type="button" class="g-link" data-clear-search>clear search</button>' : ''}</td></tr></tbody>`; }
  else {
    const flat = sortedGames();
    html = flat ? flat.map(gameRows).join('') : groups.map((grp) => {
      const label = grp.starred ? '★ STARRED' : grp.live ? '● LIVE' : `${esc(et(grp.start, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase())} · ${esc(et(grp.start, { hour: 'numeric', minute: '2-digit' }))} ET <span class="g-cd" data-countdown="${grp.start.getTime()}">${esc(countdown(grp.start.getTime()))}</span>`;
      return `${grp.leagueHead ? `<tbody class="g-lg"><tr><td colspan="${colCount()}">${esc(grp.leagueHead.title)}<span class="g-n">${grp.leagueHead.count} ${grp.leagueHead.count === 1 ? 'game' : 'games'}</span></td></tr></tbody>` : ''}<tbody class="g-sep"><tr><td colspan="${colCount()}">${label}<span class="g-n">${grp.games.length} ${grp.games.length === 1 ? 'game' : 'games'}</span></td></tr></tbody>${grp.games.map(gameRows).join('')}`;
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
  if (api.settings.game === key) el.big.innerHTML = bigChart(api, g, { pick: api.chartPick(g.key), range: api.settings.range });
  const sc = el.table.querySelector(`tbody[data-game="${CSS.escape(key)}"] .g-xscroll`); if (sc && top) sc.scrollTop = top;
}

// ---------- panels ----------
/** The detail under the big latency number: sample counts and the other hop, never the big number again. */
function latBits(api, L) {
  const out = [];
  if (L.page) { out.push(`median of ${L.page.n}`); if (L.server) out.push(`server ${api.secs(L.server.p50)} (median of ${L.server.n})`); }
  else if (L.server) { out.push(`median of ${L.server.n}`); if (L.server.pm == null) out.push('book clock not synced'); if (L.hop) out.push(`+${api.secs(L.hop.p50)} to this page`); }
  return out.join(' · ') || 'no samples yet';
}
function renderFeeds() {
  const prices = { draftkings: 0, fanduel: 0 }; const moves = api.state.moveCount || {};
  for (const q of api.state.quotes.values()) if (q.book in prices) prices[q.book]++;
  const rows = BOOKS.map((b) => {
    const s = api.state.sources[b] || {}; const f = api.feedState(b); const L = api.latency(b); const fr = api.freshness(b);
    const T = api.latencyText(b);
    const lat = f !== 'live' ? '—' : T.short;
    const C = api.fanduelCadence(L);
    const mode = b === 'draftkings' ? 'ws push' : `${L.push ? 'ws push + ' : ''}poll ${C.nflOnly ? C.beat : `${C.beat}–${C.turn}`}${L.interleave ? ' · 2 IPs' : ''}`;
    const snap = s.lastSnapshotAt ? `${s.snapshotVia || 'direct'} · <span data-age-ts="${s.lastSnapshotAt}">${esc(api.ago(s.lastSnapshotAt))}</span>` : '—';
    return `<tr class="f-${f}"><th><span class="g-bk g-${api.BOOK[b].cls}"></span>${api.BOOK[b].label}</th><td class="st"><i class="dot"></i>${esc(f === 'live' ? 'connected' : f)}</td><td class="xd">${esc(mode)}</td>
      <td data-age-ts="${s.lastDataAt || ''}">${esc(api.ago(s.lastDataAt))}</td><td class="big xd" title="${esc(f === 'live' ? T.title : '')}">${esc(lat)}${f === 'live' ? `<small class="lat-n">${esc(latBits(api, T.L))}</small>` : ''}</td><td>${snap}</td><td class="num xd">${prices[b]}</td><td class="num xd">${moves[b] ?? 0}</td><td class="num xd">${s.reconnects ?? 0}</td>
      <td class="fr"><span class="bar"><i data-fresh="${b}" style="width:${(fr.fill * 100).toFixed(0)}%"></i></span></td></tr>`;
  }).join('');
  el.feeds.innerHTML = `<table class="g-feedt"><thead><tr><th>Book</th><th>State</th><th class="xd">Mode</th><th title="Last message from the book. DraftKings only sends when a price changes (plus a check every 10 s); FanDuel answers every second. Not a delay: see latency.">Heard</th><th class="xd" title="Medians of measured samples only: book → our server, and book → this page (DraftKings stamps every change). Point at a cell for sample counts, age and clock error.">Latency</th><th title="Last full re-download that double-checks the stream">Snapshot</th><th class="num xd">Prices</th><th class="num xd" title="Price moves seen since this page opened">Moves</th><th class="num xd">Reconnects</th><th>Freshness</th></tr></thead><tbody>${rows}
    <tr class="xd f-${api.state.connected ? 'live' : api.connectionLost() ? 'lost' : 'connecting'}"><th><span class="g-bk"></span>This page</th><td class="st"><i class="dot"></i>${api.state.connected ? 'open' : api.state.everConnected ? 'reconnecting' : 'connecting'}</td><td>SSE stream</td><td colspan="7">${esc(api.state.sources.draftkings?.region || 'Ontario')} · clock ±${api.state.rtt != null ? Math.round(api.state.rtt / 2) : '—'} ms · ${esc(api.league().title)}</td></tr></tbody></table>`;
}
function renderBanner() {
  const st = api.state; const b = el.banner;
  const set = (cls, txt) => { b.hidden = false; b.className = `g-banner ${cls}`; b.setAttribute('role', cls === 'info' ? 'status' : 'alert'); b.innerHTML = txt; };
  if (!st.everConnected) return set('info', '<b>Connecting…</b> waiting for the first snapshot.');
  if (st.switching) return set('info', `<b>Loading ${esc(api.league().title)}…</b> getting both books' prices.`);
  if (api.connectionLost()) return set('bad', '<b>Connection lost · reconnecting.</b> Prices shown are from before the drop and are greyed out.');
  if (!st.connected) return set('info', '<b>Reconnecting…</b> prices stay on screen and refresh in a moment.');
  const down = BOOKS.filter((x) => !['live', 'connecting'].includes(api.feedState(x)));
  if (down.length) return set('warn', `<b>${down.map((x) => api.BOOK[x].label).join(' and ')} ${down.length > 1 ? 'are' : 'is'} stale.</b> Those prices are greyed and cannot win.`);
  b.hidden = true;
}
function renderWire() {
  const keys = api.viewKeys(); const moves = api.state.moves.filter((m) => keys.has(m.gameKey)).slice(0, 6);
  el.wire.innerHTML = moves.length ? `<table class="g-pt">${moves.map((m) => {
    const lm = m.prevLine != null && m.prevLine !== m.line;
    const fmt = (l, o) => `${lm ? `${api.fmtLine(m.market, m.side, l)} ` : ''}${api.fmtOdds(o)}`;
    return `<tr><td class="mut" data-age-local="${m.at}">${esc(api.ago(m.at, Date.now()))}</td><th>${esc(m.game.replace(' @ ', '@'))}</th><td>${esc(m.sideName)} ${SHORT[m.market]}</td><td class="mono">${esc(fmt(m.prevLine, m.prevOdds))} → <b>${esc(fmt(m.line, m.odds))}</b></td><td>${api.BOOK[m.book].short}</td></tr>`;
  }).join('')}</table>` : `<p class="g-note">${api.state.everConnected ? (api.filtering() && api.state.moves.length ? 'No price moves in the games shown since this page opened.' : 'No price moves since this page opened. Pregame lines can sit still for minutes; live games move constantly.') : 'Waiting for the first prices…'}</p>`;
}
const MARKET_NAME = { moneyline: 'Moneyline', spread: 'Spread', total: 'Total', 'alt-spread': 'Alt spread', 'alt-total': 'Alt total' };
function renderHolds() {
  const keys = api.viewKeys();
  const main = api.tightest(9).map((t) => ({ ...t, alt: null }));
  const alt = (api.state.extrasHolds || []).map((t) => ({ game: api.state.games.get(t.gameKey), market: t.kind === 'alt-spread' ? 'spread' : 'total', hold: t.hold, a: { ...t.a, side: t.a.subject }, b: { ...t.b, side: t.b.subject }, alt: t.kind })).filter((t) => t.game && keys.has(t.game.key));
  // three by default; "more" opens up to nine, "fewer" goes back to three (the same choice as the other design)
  const all = [...main, ...alt].sort((a, b) => a.hold - b.hold).slice(0, 9);
  const more = !!api.state.holdsMore; const items = all.slice(0, more ? 9 : 3);
  const toggle = all.length > 3 ? `<button type="button" class="g-link g-holds-more" data-holds-more aria-expanded="${more}">${more ? '▴ fewer' : `▾ ${all.length - 3} more`}</button>` : '';
  const team = (g, side) => esc(g[side]?.abbr ?? '');
  const leg = (g, m, o) => `<span class="g-leg-name">${m === 'total' ? (o.side === 'over' ? 'Over' : 'Under') + ' ' + o.line : `${team(g, o.side)}${m === 'spread' ? ` ${api.fmtLine('spread', o.side, o.line)}` : ''}`}</span> <b>${esc(api.fmtOdds(o.odds))}</b> <span class="mut">${api.BOOK[o.book].short}</span>`;
  const head = '<thead><tr><th>Game</th><th>Market</th><th colspan="2">Best price on each side</th><th class="h" title="What the books keep if you bet both sides at these prices">Margin</th></tr></thead>';
  const html = items.length ? `<table class="g-pt g-holdt">${head}<tbody>${items.map((t) => `<tr class="${t.hold < 0 ? 'arb' : ''}" data-goto="${esc(t.game.key)}"${t.alt ? ` data-alt="${t.alt}"` : ''} title="Jump to the game"><th>${team(t.game, 'away')} @ ${team(t.game, 'home')}</th><td>${MARKET_NAME[t.alt || t.market]}</td><td class="mono">${leg(t.game, t.market, t.a)}</td><td class="mono">${leg(t.game, t.market, t.b)}</td><td class="h">${pct(t.hold)}${t.hold < 0 ? ' <em>arbitrage</em>' : ''}</td></tr>`).join('')}</tbody></table>`
    : `<p class="g-note">${!api.state.everConnected ? 'Waiting for prices.' : api.filtering() ? 'No market with both books in the games shown.' : 'No market with both books on the same line yet.'}</p>`;
  const out = html + toggle;
  if (out !== renderHolds.last) { renderHolds.last = out; el.holds.innerHTML = out; }
  const scope = api.filtering() ? 'in the games shown' : ''; const sc = root.querySelector('#g-holds-scope'); if (sc && sc.textContent !== scope) sc.textContent = scope;
}
function tick() {
  for (const n of root.querySelectorAll('[data-age-ts]')) n.textContent = api.ago(Number(n.dataset.ageTs) || null);
  for (const n of root.querySelectorAll('[data-age-local]')) n.textContent = api.ago(Number(n.dataset.ageLocal), Date.now());
  for (const n of root.querySelectorAll('[data-countdown]')) n.textContent = countdown(Number(n.dataset.countdown));
  for (const n of root.querySelectorAll('[data-fresh]')) n.style.width = `${(api.freshness(n.dataset.fresh).fill * 100).toFixed(0)}%`;
  if ((tick.n = (tick.n || 0) + 1) % 8 === 0) renderHolds();
  const sig = BOOKS.map(api.feedState).join('|') + api.state.connected + api.connectionLost();
  if (sig !== tick.sig) { tick.sig = sig; render(); }
}

export default { id: 'grid', name: 'Grid (engineering)', short: 'Engineering', css: '/themes/grid.css',
  fonts: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  mount, unmount, render, renderGame, renderFeeds, renderBanner, renderWire, renderExtras, renderExtrasToggles, renderHolds, focusSearch, toggleHelp, closeHelp, tick };
