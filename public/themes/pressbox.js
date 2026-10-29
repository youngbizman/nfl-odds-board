// Theme: Pressbox Cobalt (light). Markup and class names follow the designer's components.txt exactly.
// It only draws: data, rules and settings come from the core (public/app.js) through `api`.
const REPO = 'https://github.com/youngbizman/nfl-odds-board';
const MARKET_CLASS = { spread: 'spread', total: 'total', moneyline: 'money' };
const MARKET_NAME = { spread: 'Spread', total: 'Total', moneyline: 'Moneyline' };
const ROW = { spread: 2, total: 3, moneyline: 4 };
// CSS jersey colours (decorative; team text carries the meaning)
const KIT = { ARI: ['#97233f', '#f0e9df'], ATL: ['#a6323e', '#f0e9df'], BAL: ['#4d367a', '#eadbb3'], BUF: ['#2657a5', '#eddddd'], CAR: ['#2998c9', '#152f3b'],
  CHI: ['#1b2a44', '#d4612a'], CIN: ['#e8622a', '#1d1d1d'], CLE: ['#ede9df', '#bd4a1c'], DAL: ['#e5e9ee', '#25446d'], DEN: ['#e8622a', '#13294b'],
  DET: ['#1f78b4', '#c7ccd1'], GB: ['#254e40', '#e9bd4c'], HOU: ['#14283a', '#b03a3e'], IND: ['#2c5aa0', '#f0f0f0'], JAX: ['#16697a', '#d7a22a'],
  KC: ['#c8293b', '#f2c14e'], LV: ['#262626', '#b5bbbf'], LAC: ['#2a86c8', '#f6c445'], LAR: ['#1f3f8f', '#f2b134'], MIA: ['#1c8f96', '#ef7a3b'],
  MIN: ['#4f2d7f', '#f2c94c'], NE: ['#1b2f4d', '#c03a44'], NO: ['#262626', '#d3bc8d'], NYG: ['#22336e', '#b8414a'], NYJ: ['#1f5c46', '#f0f0f0'],
  PHI: ['#1d5157', '#b5bbbf'], PIT: ['#292c30', '#edc04b'], SF: ['#a8232b', '#c9ad73'], SEA: ['#1b2f4d', '#7cbf45'], TB: ['#c63a31', '#eadcc9'],
  TEN: ['#5197d6', '#13294b'], WAS: ['#5a1f1f', '#f1b939'] };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const etTime = (d, opts) => d.toLocaleString('en-US', { timeZone: 'America/Toronto', ...opts });

let api, root, el = {};

function mount(r, a) {
  api = a; root = r;
  const picker = api.themes.length > 1
    ? `<label class="field theme-field">Design<select id="theme-picker">${api.themes.map((t) => `<option value="${t.id}"${t.id === api.settings.theme ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : '';
  root.innerHTML = `
  <a class="skip" href="#board">Skip to prices</a>
  <div class="app">
    <header class="mast">
      <span class="wordmark">PRESSBOX / ODDS</span>
      <div class="mast-links"><span class="demo-label">Ontario · DraftKings + FanDuel · live</span><a href="${REPO}#readme">How it works</a>${picker}
        <button type="button" class="icon-btn" id="scheme-btn" title="Light / dark (d)" aria-label="Switch light or dark"></button>
        <button type="button" class="icon-btn" id="help-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-expanded="false">?</button></div>
    </header>
    <div class="help" id="help" hidden role="dialog" aria-label="Keyboard shortcuts">
      <strong>Keyboard</strong>
      <dl><dt>/</dt><dd>find a team</dd><dt>1 2 3</dt><dd>best price · DraftKings · FanDuel</dd><dt>c</dt><dd>compact / comfortable</dd>
      <dt>d</dt><dd>dark / light</dd><dt>s</dt><dd>star the game you are on</dd><dt>Enter</dt><dd>chart the focused price</dd><dt>Esc</dt><dd>close</dd></dl>
    </div>
    <section class="heading">
      <div><h1>NFL / <span>odds.</span></h1><p class="subtitle">Best price across DraftKings and FanDuel, live. Kickoffs in ET.</p></div>
      <div class="view" role="group" aria-label="Sportsbook view">
        <button type="button" data-view="best">Best price</button><button type="button" data-view="draftkings">DraftKings only</button><button type="button" data-view="fanduel">FanDuel only</button>
      </div>
    </section>
    <div class="toolbar" aria-label="Board controls">
      <div class="field phase-field"><span id="phase-label">Show</span><div class="segment" role="group" aria-labelledby="phase-label">
        <button type="button" data-phase="all">All</button><button type="button" data-phase="live">Live</button><button type="button" data-phase="pregame">Pregame</button><button type="button" data-phase="starred">★ Starred</button></div></div>
      <div class="field density-field"><span id="density-label">Density</span><div class="segment" role="group" aria-labelledby="density-label">
        <button type="button" data-density="comfortable">Comfortable</button><button type="button" data-density="compact">Compact</button></div></div>
      <label class="field search"><span>Find a team <kbd>/</kbd></span><input id="search" type="search" autocomplete="off" placeholder="Team or abbreviation"></label>
      <label class="field">Odds<select id="odds-format"><option value="american">American</option><option value="decimal">Decimal</option></select></label>
    </div>
    <section class="holds" id="holds" aria-label="Tightest markets right now"></section>
    <div class="sentinel" aria-hidden="true"></div>
    <div class="sticky">
      <div id="connection-banner" class="banner loading"><strong>Connecting to sportsbooks…</strong> Waiting for the first complete snapshot.</div>
      <div class="feeds" id="feeds"></div>
      <div class="columns" style="--markets:3"><span>GAME</span><span>SPREAD</span><span>TOTAL</span><span>MONEYLINE</span><span class="col-chart">MOVEMENT <em>· click any price to chart it</em></span></div>
    </div>
    <div class="results" id="results"></div>
    <main id="board" class="games"></main>
    <section class="wire" aria-label="Recent price moves"><h2>The wire.</h2><div id="wire"></div></section>
    <footer class="footer">
      <p>Ontario prices from DraftKings and FanDuel; every number updates on its own, nothing is simulated. The higher odds win only when both books offer the same line and both prices are live and open. Equal prices are a tie; different lines are never ranked. Hold = the books' combined margin at the best price on each side; below 0% both sides together guarantee a profit (an arbitrage).</p>
      <a href="${REPO}#readme">How it works ↗</a>
    </footer>
  </div>`;
  el = { board: root.querySelector('#board'), feeds: root.querySelector('#feeds'), banner: root.querySelector('#connection-banner'), results: root.querySelector('#results'), wire: root.querySelector('#wire'),
    holds: root.querySelector('#holds'), help: root.querySelector('#help'), sticky: root.querySelector('.sticky') };
  root.querySelectorAll('[data-density]').forEach((b) => b.addEventListener('click', () => api.set('density', b.dataset.density)));
  root.querySelector('#scheme-btn').addEventListener('click', () => api.set('scheme', document.documentElement.dataset.scheme === 'dark' ? 'light' : 'dark'));
  root.querySelector('#help-btn').addEventListener('click', () => toggleHelp());
  // the status bar condenses once it sticks to the top; on a phone it stays one line until tapped
  observer = new IntersectionObserver(([e]) => el.sticky.classList.toggle('is-stuck', !e.isIntersecting), { threshold: 0 });
  observer.observe(root.querySelector('.sentinel'));
  el.feeds.addEventListener('click', () => el.feeds.classList.toggle('is-open'));
  el.holds.addEventListener('click', (e) => {
    const t = e.target.closest('[data-goto]'); if (!t) return;
    const node = el.board.querySelector(`[data-game="${CSS.escape(t.dataset.goto)}"]`);
    if (!node) { api.set('phase', 'all'); api.set('search', ''); root.querySelector('#search').value = ''; }
    if (t.dataset.alt && !api.extrasOpen(t.dataset.goto)) api.toggleExtras(t.dataset.goto);
    if (t.dataset.market) api.pickChart(t.dataset.goto, t.dataset.market, t.dataset.side);
    if (t.dataset.alt) setTimeout(() => api.setExtras(t.dataset.goto, { kind: t.dataset.alt }), 400);
    requestAnimationFrame(() => { const n = el.board.querySelector(`[data-game="${CSS.escape(t.dataset.goto)}"]`); n?.scrollIntoView({ behavior: 'smooth', block: 'center' }); n?.classList.add('is-flagged'); setTimeout(() => n?.classList.remove('is-flagged'), 1600); });
  });
  root.querySelectorAll('.view button').forEach((b) => b.addEventListener('click', () => api.set('view', b.dataset.view)));
  root.querySelectorAll('[data-phase]').forEach((b) => b.addEventListener('click', () => api.set('phase', b.dataset.phase)));
  root.querySelector('#search').addEventListener('input', (e) => api.set('search', e.target.value));
  const fmt = root.querySelector('#odds-format'); fmt.value = api.settings.format; fmt.addEventListener('change', (e) => api.set('format', e.target.value));
  root.querySelector('#theme-picker')?.addEventListener('change', (e) => api.setTheme(e.target.value));
  const pickFrom = (t) => { const c = t.closest('.price[data-market]'); const gEl = c?.closest('[data-game]'); if (c && gEl) { api.pickChart(gEl.dataset.game, c.dataset.market, c.dataset.side); gEl.querySelector(`.price[data-market="${c.dataset.market}"][data-side="${c.dataset.side}"]`)?.focus({ preventScroll: true }); } };
  el.board.addEventListener('click', (e) => {
    const t = e.target.closest('[data-extras-toggle]'); if (t) return api.toggleExtras(t.dataset.extrasToggle);
    const st = e.target.closest('[data-star]'); if (st) return api.toggleStar(st.dataset.star);
    const k = e.target.closest('[data-x-kind]'); if (k) return api.setExtras(k.closest('[data-extras]').dataset.extras, { kind: k.dataset.xKind });
    pickFrom(e.target);
  });
  el.board.addEventListener('change', (e) => { if (e.target.matches('[data-x-both]')) api.setExtras(e.target.closest('[data-extras]').dataset.extras, { bothOnly: e.target.checked }); });
  el.board.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.price[data-market]')) { e.preventDefault(); pickFrom(e.target); } });
}
let observer = null;
function unmount() { observer?.disconnect(); root.innerHTML = ''; }
function focusSearch() { const i = root.querySelector('#search'); i.focus(); i.select(); }
function toggleHelp(force) { const open = force ?? el.help.hidden; el.help.hidden = !open; root.querySelector('#help-btn').setAttribute('aria-expanded', String(open)); }
function closeHelp() { if (el.help && !el.help.hidden) toggleHelp(false); }

// ---------- price cells ----------
function changeHtml(q, ch) {
  if (!ch) return '';
  if (ch.lineMoved) return '';
  if (!ch.dir) return '';
  return `<span class="change ${ch.dir}" aria-label="Previous price ${esc(api.fmtOdds(ch.prevOdds))}">${ch.dir === 'up' ? '↑' : '↓'} <s>${esc(api.fmtOdds(ch.prevOdds))}</s></span>`;
}
function stateClass(ch) { return ch ? (ch.lineMoved ? 'is-line' : ch.flash && ch.dir ? `is-${ch.dir}` : '') : ''; }
function tag(q) { return q ? ` data-q="${esc(`${q.gameKey}|${q.market}|${q.side}|${q.book}`)}" data-odds="${q.odds ?? ''}" data-line="${q.line ?? ''}"` : ''; }
function otherBadge(o) {
  if (!o) return '';
  if (o.suspended) return ' <span class="badge">Suspended</span>';
  const f = api.feedState(o.book);
  if (f === 'reconnecting' || f === 'lost') return ' <span class="badge warning">Reconnecting · old</span>';
  if (o.stale) return ' <span class="badge warning">Stale · may be old</span>';
  return '';
}
function lineNotice(q, ch) {
  if (!ch?.lineMoved) return '';
  return `<div class="notice"><span class="badge line-event">↔ Line moved</span> <span class="change line-change" aria-label="Line moved from ${esc(api.fmtLine(q.market, q.side, ch.prevLine))}">↔ <s>${esc(api.fmtLine(q.market, q.side, ch.prevLine))}</s></span></div>`;
}

function priceCell(g, market, side, idx) {
  const cls = `price ${MARKET_CLASS[market]} ${idx === 0 ? 'away' : 'home'}`;
  const sideName = market === 'total' ? (side === 'over' ? 'Over' : 'Under') : (side === 'home' ? g.home.abbr : g.away.abbr);
  const label = `${MARKET_NAME[market]} · ${sideName}`;
  const pos = `--mobile-row:${ROW[market]};--mobile-column:${idx + 1}`;
  const pick = api.chartPick(g.key); const charted = pick.market === market && pick.side === side ? ' is-charted' : '';
  const head = (extra, q) => `<div class="${cls} ${extra}${charted}" role="group" tabindex="0" data-market="${market}" data-side="${side}" aria-label="${esc(`${g.away.abbr} @ ${g.home.abbr} · ${label}`)}. Press Enter to chart it."${tag(q)} style="${pos}"><span class="market-label">${esc(label)}</span>`;
  const c = api.cell(g, market, side);
  const B = api.BOOK;

  if (c.view !== 'best') { // single-book view: each number with its own price-change age
    const q = c.single;
    if (!q) return `${head('is-unavailable', null)}<div class="quote"><strong class="odds">—</strong></div><div class="compare">${B[c.view].label} · not offered</div></div>`;
    const ch = api.change(q);
    const off = q.suspended || q.stale;
    return `${head(`${stateClass(ch)}${off ? ' is-partial' : ''}`, q)}<div class="quote${q.stale ? ' is-stale' : ''}"><span class="line">${esc(api.fmtLine(market, side, q.line))}</span><strong class="odds">${esc(api.fmtOdds(q.odds))}</strong>${changeHtml(q, ch)}</div>
      <div class="compare"><span class="book ${B[q.book].cls}">${B[q.book].label}</span>${otherBadge(q)}</div>${lineNotice(q, ch)}
      <div class="price-age" data-age-ts="${q.updatedAt}" data-age-prefix="updated ">updated ${esc(api.ago(q.updatedAt))}</div></div>`;
  }

  const { cmp, dk, fd } = c;
  const lineHtml = (q) => market === 'moneyline' ? '' : `<span class="line">${esc(api.fmtLine(market, side, q.line))}</span>`;
  if (cmp.kind === 'best' || cmp.kind === 'tie') {
    const q = cmp.best; const ch = api.change(q);
    if (cmp.kind === 'tie') {
      return `${head(`is-tie ${stateClass(ch)}`, q)}<div class="quote">${lineHtml(q)}<strong class="odds">${esc(api.fmtOdds(q.odds))}</strong><span class="badge">Tie</span></div>
        <div class="compare"><span class="book dk">DraftKings</span> + <span class="book fd">FanDuel</span></div>${lineNotice(q, ch)}</div>`;
    }
    const other = cmp.offers.find((o) => o.book !== q.book);
    const edge = api.cents(q.odds, other.odds);
    return `${head(`is-best win-${B[q.book].cls} ${stateClass(ch)}`, q)}<div class="quote">${lineHtml(q)}<strong class="odds">${esc(api.fmtOdds(q.odds))}</strong>${changeHtml(q, ch)}</div>
      <div class="compare"><span class="book ${B[q.book].cls}">${B[q.book].label}</span> <span class="edge" title="${edge}¢ better than ${B[other.book].label}">+${edge}¢</span><span class="separator">·</span><span class="other"><span class="book ${B[other.book].cls}">${B[other.book].short}</span> ${esc(api.fmtOdds(other.odds))}</span></div>${lineNotice(q, ch)}</div>`;
  }
  if (cmp.kind === 'different') {
    const offer = (q) => { const ch = api.change(q); return `<div class="offer"${tag(q)}><div class="offer-value"><span class="line">${esc(api.fmtLine(market, side, q.line))}</span><span class="offer-odds">${esc(api.fmtOdds(q.odds))}</span>${changeHtml(q, ch)}</div><span class="book ${B[q.book].cls}">${B[q.book].label}</span></div>`; };
    const moved = cmp.offers.map((q) => api.change(q)).find((ch) => ch);
    return `${head(`is-different ${stateClass(moved)}`, null)}<div class="offers">${[dk, fd].map(offer).join('')}</div><div class="notice">≠ Different lines · no best price</div></div>`;
  }
  if (cmp.kind === 'partial') {
    const q = cmp.best; const ch = api.change(q); const otherBook = q.book === 'draftkings' ? 'fanduel' : 'draftkings'; const o = otherBook === 'draftkings' ? dk : fd;
    const otherHtml = o ? `<span class="other${o.suspended ? ' is-suspended' : ' is-stale'}"><span class="book ${B[otherBook].cls}">${B[otherBook].short}</span> ${market === 'moneyline' ? '' : esc(api.fmtLine(market, side, o.line)) + ' '}${esc(api.fmtOdds(o.odds))}${otherBadge(o)}</span>` : `<span class="other">${B[otherBook].label} · not offered</span>`;
    return `${head(`is-partial ${stateClass(ch)}`, q)}<div class="quote">${lineHtml(q)}<strong class="odds">${esc(api.fmtOdds(q.odds))}</strong>${changeHtml(q, ch)}</div>
      <div class="compare"><span class="book ${B[q.book].cls}">${B[q.book].label}</span> · only available offer<span class="separator">·</span>${otherHtml}</div>${lineNotice(q, ch)}</div>`;
  }
  // none eligible
  const offs = [dk, fd].filter(Boolean);
  if (!offs.length) return `${head('is-unavailable', null)}<div class="quote"><strong class="odds">—</strong></div><div class="compare">Not offered by either book</div></div>`;
  const lost = api.feedState('draftkings') === 'lost';
  return `${head('is-unavailable', null)}<div class="offers">${offs.map((q) => `<div class="offer is-stale" aria-disabled="true"${tag(q)}><div class="offer-value">${market === 'moneyline' ? '' : `<span class="line">${esc(api.fmtLine(market, side, q.line))}</span>`}<span class="offer-odds">${esc(api.fmtOdds(q.odds))}</span></div><span class="book ${B[q.book].cls}">${B[q.book].label}</span>${otherBadge(q)}</div>`).join('')}</div>
    <div class="notice">${lost ? 'Before disconnect · unavailable' : 'No live, open price right now'}</div></div>`;
}

function teamHtml(t, side) {
  const [shirt, trim] = KIT[t.abbr] || ['#c9cfd5', '#5b6673'];
  return `<div class="team ${side}"><span class="kit" style="--shirt:${shirt};--trim:${trim}" aria-hidden="true"><i></i></span><div><span class="team-name">${esc(t.abbr)}</span><span class="team-full">${esc(t.name)}</span></div></div>`;
}
function gameInner(g) {
  const meta = g.status === 'live' ? `<span class="live-tag">● Live</span> · ${esc(g.away.abbr)} @ ${esc(g.home.abbr)}` : `${esc(etTime(new Date(g.start), { weekday: 'short', hour: 'numeric', minute: '2-digit' }))} ET · ${esc(g.away.abbr)} @ ${esc(g.home.abbr)}`;
  const cells = (idx) => api.MARKETS.map(([m, sides]) => priceCell(g, m, sides[idx], idx)).join('');
  const star = api.isStarred(g.key);
  return `<div class="game-meta"><span class="meta-left"><button type="button" class="star${star ? ' is-on' : ''}" data-star="${esc(g.key)}" aria-pressed="${star}" title="${star ? 'Unstar' : 'Star'} this game (s)">${star ? '★' : '☆'}</button>${meta}</span>${holdsLine(g)}${extrasToggle(g)}</div><div class="match" style="--markets:3">${teamHtml(g.away, 'away')}${cells(0)}${teamHtml(g.home, 'home')}${cells(1)}${chartHtml(g)}</div>
    ${api.extrasOpen(g.key) ? `<section class="extras" data-extras="${esc(g.key)}" aria-label="More lines for ${esc(`${g.away.abbr} @ ${g.home.abbr}`)}">${extrasInner(g.key)}</section>` : ''}`;
}

// ---------- hold: the books' combined margin at the best price on each side ----------
const pctTxt = (h) => `${(h * 100).toFixed(1)}%`;
function holdsLine(g) {
  const h = api.holds(g); const parts = [['spread', 'Spread'], ['total', 'Total'], ['moneyline', 'ML']].filter(([m]) => h[m]);
  if (!parts.length) return '';
  return `<span class="hold-line" title="Hold at the best price on each side (either book). Lower is better for you; below 0% is an arbitrage.">Hold ${parts.map(([m, n]) => `<span class="hold${h[m].hold < 0 ? ' is-arb' : h[m].hold < 0.02 ? ' is-low' : ''}">${n} ${pctTxt(h[m].hold)}</span>`).join(' ')}</span>`;
}
function legTxt(g, market, o) {
  const B = api.BOOK[o.book];
  const who = market === 'total' ? (o.side === 'over' ? 'O' : 'U') : g[o.side]?.abbr ?? '';
  const line = market === 'moneyline' ? '' : ` ${market === 'total' ? o.line : api.fmtLine('spread', o.side, o.line)}`;
  return `<span class="leg">${esc(who)}${esc(line)} <b>${esc(api.fmtOdds(o.odds))}</b> <span class="book ${B.cls}">${B.short}</span></span>`;
}
function renderHolds() {
  if (!el.holds) return;
  const main = api.tightest(6).map((t) => ({ ...t, alt: null }));
  const alt = (api.state.extrasHolds || []).slice(0, 3).map((t) => ({ game: api.state.games.get(t.gameKey), market: t.kind === 'alt-spread' ? 'spread' : 'total', hold: t.hold, a: t.a, b: t.b, alt: t.kind })).filter((t) => t.game);
  const items = [...main, ...alt].sort((a, b) => a.hold - b.hold).slice(0, 8);
  if (!items.length) { el.holds.innerHTML = ''; renderHolds.last = ''; return; }
  const arbs = items.filter((t) => t.hold < 0).length;
  const html = `<div class="holds-head"><h2>Tightest markets.</h2><span>${arbs ? `<b class="arb-flag">${arbs} arbitrage${arbs > 1 ? 's' : ''} right now</b>` : 'Best price on each side, either book · lower hold = better for you'}</span></div>
    <ul class="holds-list">${items.map((t) => {
      const g = t.game; const name = t.alt ? (t.alt === 'alt-spread' ? 'Alt spread' : 'Alt total') : { spread: 'Spread', total: 'Total', moneyline: 'Moneyline' }[t.market];
      const side = (o, fallback) => ({ ...o, side: o.subject || o.side || fallback });
      return `<li><button type="button" class="hold-card${t.hold < 0 ? ' is-arb' : ''}" data-goto="${esc(g.key)}" ${t.alt ? `data-alt="${t.alt}"` : `data-market="${t.market}" data-side="${t.market === 'total' ? 'over' : 'home'}"`}>
        <span class="hc-top"><span>${esc(g.away.abbr)} @ ${esc(g.home.abbr)} · ${name}</span><span class="hc-hold">${t.hold < 0 ? 'ARB ' : ''}${pctTxt(t.hold)}</span></span>
        <span class="hc-legs">${legTxt(g, t.market, side(t.a, t.market === 'total' ? 'over' : 'away'))}${legTxt(g, t.market, side(t.b, t.market === 'total' ? 'under' : 'home'))}</span></button></li>`;
    }).join('')}</ul>`;
  if (html !== renderHolds.last) { renderHolds.last = html; el.holds.innerHTML = html; } // no flicker while nothing changed
}

// ---------- "More lines": alt spreads/totals and player props, both books, same number only ----------
function extrasToggle(g) {
  const c = api.extrasCount(g.key); const open = api.extrasOpen(g.key);
  if (!c && !open) return '';
  const label = c ? `More lines · ${c.both} on both books` : 'More lines';
  return `<button type="button" class="extras-toggle" data-extras-toggle="${esc(g.key)}" aria-expanded="${open}">${esc(label)} <span aria-hidden="true">${open ? '▴' : '▾'}</span></button>`;
}
function oddsCell(o, cmp) {
  if (!o) return '<td class="x-none">—</td>';
  const win = (cmp.kind === 'best' && cmp.best.book === o.book) || (cmp.kind === 'tie' && cmp.books.includes(o.book));
  const cls = [o.suspended ? 'x-susp' : '', win ? (cmp.kind === 'tie' ? 'x-tie' : 'x-best') : '', o.moved ? `x-${o.moved}` : ''].filter(Boolean).join(' ');
  const prev = o.moved && o.prevOdds != null ? ` <s>${esc(api.fmtOdds(o.prevOdds))}</s>` : '';
  const tag = o.suspended ? ' <span class="badge">Suspended</span>' : win && cmp.kind === 'tie' ? ' <span class="badge">Tie</span>' : '';
  return `<td class="${cls}">${o.moved ? `<span class="change ${o.moved}">${o.moved === 'up' ? '↑' : '↓'}</span> ` : ''}<strong>${esc(api.fmtOdds(o.odds))}</strong>${prev}${tag}</td>`;
}
function extrasInner(gk) {
  const v = api.extrasView(gk); if (!v) return '';
  if (!v.loaded) return '<p class="x-note">Loading both books\' alt lines and player props…</p>';
  if (!v.kinds.length) return '<p class="x-note">Neither book has alt lines or player props up for this game yet.</p>';
  const tabs = v.kinds.map((k) => `<button type="button" data-x-kind="${k.id}" aria-pressed="${k.id === v.kind}">${esc(k.label)} <span class="x-count">${v.bothOnly ? k.both : k.all}</span></button>`).join('');
  const st = v.status || {};
  const head = `<div class="x-bar"><div class="segment x-tabs" role="group" aria-label="Kind of bet">${tabs}</div>
    <label class="x-both"><input type="checkbox" data-x-both ${v.bothOnly ? 'checked' : ''}> Only lines both books offer</label></div>`;
  const body = v.rows.length ? `<div class="x-scroll" tabindex="0" aria-label="${esc(api.state.extrasKinds[v.kind] || v.kind)} table"><table class="x-table"><thead><tr><th scope="col">${v.kind === 'alt-spread' || v.kind === 'alt-total' ? 'Line' : 'Player'}</th><th scope="col"><span class="book dk">DraftKings</span></th><th scope="col"><span class="book fd">FanDuel</span></th></tr></thead>
    <tbody>${v.rows.slice(0, 250).map((r) => `<tr><th scope="row">${esc(r.label)}</th>${r.cells.map((o) => oddsCell(o, r.cmp)).join('')}</tr>`).join('')}</tbody></table></div>
    ${v.rows.length > 250 ? `<p class="x-note">Showing 250 of ${v.rows.length}.</p>` : ''}`
    : `<p class="x-note">${v.bothOnly ? 'No line here that both books offer at the same number. Untick the box to see each book\'s own lines.' : 'Nothing here right now.'}</p>`;
  const foot = `<p class="x-note">Best = higher odds on the exact same line and threshold; anything else is shown, never ranked. DraftKings pushes changes as they happen (<span data-x-age="draftkings" data-age-ts="${st.draftkings?.lastDataAt || ''}" data-age-prefix="data ">data ${esc(api.ago(st.draftkings?.lastDataAt))}</span>); FanDuel is re-checked every 3 s while this is open (<span data-x-age="fanduel" data-age-ts="${st.fanduel?.lastDataAt || ''}" data-age-prefix="data ">data ${esc(api.ago(st.fanduel?.lastDataAt))}</span>).</p>`;
  return head + body + foot;
}
function renderExtras(gk) {
  const node = el.board.querySelector(`[data-extras="${CSS.escape(gk)}"]`);
  if (!node) return renderGame(gk);
  const top = node.querySelector('.x-scroll')?.scrollTop || 0;
  node.innerHTML = extrasInner(gk);
  const sc = node.querySelector('.x-scroll'); if (sc && top) sc.scrollTop = top;
}
function renderExtrasToggles() {
  for (const node of el.board.querySelectorAll('[data-game]')) {
    const g = api.state.games.get(node.dataset.game); if (!g) continue;
    const meta = node.querySelector('.game-meta'); const old = meta?.querySelector('.extras-toggle');
    const html = extrasToggle(g); if (old) old.outerHTML = html || ''; else if (html && meta) meta.insertAdjacentHTML('beforeend', html);
  }
}

// ---------- movement chart: implied chance of the picked side, one line per book ----------
const chance = (odds) => { const d = api.decimalOdds(odds); return d ? 100 / d : null; };
function chartHtml(g) {
  const pick = api.chartPick(g.key); const S = api.series(g, pick.market, pick.side);
  const books = api.settings.view === 'best' ? ['draftkings', 'fanduel'] : [api.settings.view];
  const sideName = pick.market === 'total' ? (pick.side === 'over' ? 'Over' : 'Under') : g[pick.side].abbr;
  const what = pick.market === 'moneyline' ? `${sideName} to win` : pick.market === 'spread' ? `${sideName} spread` : `Total · ${sideName}`;
  let lo = Infinity, hi = -Infinity, moves = 0;
  for (const b of books) { const pts = S.books[b]; moves += Math.max(0, pts.length - 1); for (const p of pts) { const v = chance(p[1]); lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  const head = `<div class="chart-head" title="Implied chance = 1 ÷ decimal odds. It includes the book's margin, so the two sides add up to a bit over 100%."><span>${esc(what)} · implied chance</span>`;
  if (!Number.isFinite(lo)) return `<div class="chart">${head}</div><p class="chart-empty">No price yet.</p></div>`;
  const mid = (lo + hi) / 2, half = Math.max(((hi - lo) / 2) * 1.2, 1.5); lo = mid - half; hi = mid + half;
  const span = Math.max(1, S.to - S.from);
  const X = (t) => ((Math.min(Math.max(t, S.from), S.to) - S.from) / span) * 1000, Y = (v) => (1 - (v - lo) / (hi - lo)) * 100;
  let paths = '', dots = '', now = '';
  for (const b of books) {
    const pts = S.books[b]; if (!pts.length) continue; const B = api.BOOK[b];
    let d = `M${X(pts[0][0]).toFixed(1)},${Y(chance(pts[0][1])).toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
      d += `H${X(pts[i][0]).toFixed(1)}V${Y(chance(pts[i][1])).toFixed(2)}`;
      if (pts[i][2] !== pts[i - 1][2] && pick.market !== 'moneyline') dots += `<i class="dot ${B.cls}" style="left:${(X(pts[i][0]) / 10).toFixed(2)}%;top:${Y(chance(pts[i][1])).toFixed(2)}%" title="${B.label}: line ${esc(api.fmtLine(pick.market, pick.side, pts[i - 1][2]))} → ${esc(api.fmtLine(pick.market, pick.side, pts[i][2]))}"></i>`;
    }
    paths += `<path class="s-${B.cls}" d="${d}H1000"/>`;
    const last = pts[pts.length - 1];
    now += `<span class="book ${B.cls}">${B.short} ${chance(last[1]).toFixed(1)}%</span>`;
  }
  const t0 = new Date(S.from).toLocaleString('en-US', { timeZone: 'America/Toronto', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const label = `${what}, implied chance: ${books.map((b) => { const p = S.books[b]; return p.length ? `${api.BOOK[b].label} ${chance(p[p.length - 1][1]).toFixed(1)}%` : ''; }).filter(Boolean).join(', ')}; ${moves} ${moves === 1 ? 'move' : 'moves'} since ${t0}.`;
  return `<div class="chart" role="img" aria-label="${esc(label)}">${head}<span class="chart-now">${now}</span></div>
    <div class="plot"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><line class="grid" x1="0" x2="1000" y1="50" y2="50"/>${paths}</svg>
      <span class="y y-hi">${hi.toFixed(1)}%</span><span class="y y-lo">${lo.toFixed(1)}%</span>${dots}</div>
    <div class="chart-foot"><span>${S.live ? 'kickoff' : esc(t0)}</span><span>${moves ? `${moves} ${moves === 1 ? 'move' : 'moves'}` : 'no moves yet'}</span><span>now</span></div></div>`;
}

// ---------- sections ----------
function render() {
  root.querySelectorAll('.view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === api.settings.view)));
  root.querySelectorAll('[data-phase]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.phase === api.settings.phase)));
  root.querySelectorAll('[data-density]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.density === api.settings.density)));
  const dark = document.documentElement.dataset.scheme === 'dark';
  const sb = root.querySelector('#scheme-btn'); sb.textContent = dark ? '☀' : '☾'; sb.setAttribute('aria-label', dark ? 'Switch to light' : 'Switch to dark');
  const groups = api.groups();
  const total = groups.reduce((n, g) => n + g.games.length, 0), live = groups.find((g) => g.live)?.games.length || 0;
  el.results.innerHTML = `<span>${total} ${total === 1 ? 'game' : 'games'} shown · ${live} live</span><span>${api.settings.format === 'decimal' ? 'Decimal' : 'American'} odds</span>`;
  if (!api.state.everConnected) el.board.innerHTML = '';
  else if (!total) el.board.innerHTML = `<div class="empty"><strong>No games match.</strong>${api.settings.search || api.settings.phase !== 'all' ? 'Clear the search or choose All to see every game.' : 'Neither book has NFL game lines up right now; the board fills itself as soon as one does.'}</div>`;
  else el.board.innerHTML = groups.map((grp) => `<section class="kickoff-group${grp.starred ? ' is-starred' : ''}"><h2 class="kickoff">${grp.starred ? '<span class="star-tag">★ Starred</span> pinned to the top' : grp.live ? '<span class="live-tag">● Live</span> In progress' : `${esc(etTime(grp.start, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + etTime(grp.start, { hour: 'numeric', minute: '2-digit' }) + ' ET')} <span class="countdown" data-countdown="${grp.start.getTime()}">${esc(countdown(grp.start.getTime()))}</span>`}<span class="group-count">${grp.games.length} ${grp.games.length === 1 ? 'game' : 'games'}</span></h2>
      ${grp.games.map((g) => `<article class="game" aria-label="${esc(`${g.away.abbr} @ ${g.home.abbr}`)}" data-game="${esc(g.key)}">${gameInner(g)}</article>`).join('')}</section>`).join('');
  renderFeeds(); renderBanner(); renderWire(); renderHolds();
}
function renderGame(key) {
  const g = api.state.games.get(key); const node = el.board.querySelector(`[data-game="${CSS.escape(key)}"]`);
  if (!g || !node) return;
  const top = node.querySelector('.x-scroll')?.scrollTop || 0;
  node.innerHTML = gameInner(g);
  const sc = node.querySelector('.x-scroll'); if (sc && top) sc.scrollTop = top;
}
function renderFeeds() {
  el.feeds.innerHTML = ['draftkings', 'fanduel'].map((b) => {
    const s = api.state.sources[b] || {}; const f = api.feedState(b); const L = api.latency(b); const fr = api.freshness(b);
    const status = { live: '● Live', stale: '! Stale', reconnecting: '↻ Reconnecting', lost: '↻ Reconnecting', connecting: '… Connecting' }[f];
    const cls = f === 'stale' ? ' is-stale' : f === 'reconnecting' || f === 'lost' ? ' is-reconnecting' : '';
    const how = b === 'draftkings' ? 'push over WebSocket' : `polled every ${api.secs(L.beatMs)}${L.interleave ? ' from 2 IPs' : ''}`;
    let timing;
    if (f !== 'live') timing = 'Timing bound unavailable';
    else if (b === 'draftkings') timing = L.bookToScreenMs != null ? `book to screen ${api.secs(L.bookToScreenMs)}${L.clockPm != null ? ` ±${L.clockPm} ms` : ''}${L.measured ? '' : ' (server-measured)'}` : 'book to screen: measuring on the next move';
    else timing = `any number is at most ${api.secs(L.maxAgeMs)} old`;
    return `<article class="feed${cls}" id="feed-${b}"><div class="feed-head"><span><strong class="feed-name">${api.BOOK[b].label}</strong><span class="status">${status}</span></span><span class="feed-age" data-age-ts="${s.lastDataAt || ''}" data-age-prefix="data ">data ${esc(api.ago(s.lastDataAt))}</span></div>
      <p>${esc(s.region || 'Ontario')} · ${esc(how)} · <span class="latency">${esc(timing)}</span></p>
      <p class="last-move" data-age-ts="${s.lastChangeAt || ''}" data-age-prefix="Last price move ">Last price move ${esc(api.ago(s.lastChangeAt))}</p>
      <div class="freshness" role="progressbar" aria-label="${api.BOOK[b].label} data age within its stale limit" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(fr.fill * 100)}"><span data-fresh="${b}" style="width:${(fr.fill * 100).toFixed(1)}%"></span></div></article>`;
  }).join('');
}
function renderBanner() {
  const st = api.state; const b = el.banner;
  const set = (cls, html) => { b.hidden = false; b.className = `banner${cls ? ' ' + cls : ''}`; b.setAttribute('role', cls === 'loading' ? 'status' : 'alert'); b.innerHTML = html; };
  if (!st.everConnected) return set('loading', '<strong>Connecting to sportsbooks…</strong> Waiting for the first complete snapshot.');
  if (!st.connected) return set('lost', '<strong>Connection lost · reconnecting.</strong> All displayed prices are from before the drop and unavailable.');
  const down = ['draftkings', 'fanduel'].filter((x) => api.feedState(x) !== 'live' && api.feedState(x) !== 'connecting');
  if (down.length === 2) return set('lost', '<strong>Both books unavailable.</strong> Prices shown may be old; none of them can win.');
  if (down.length === 1) { const d = api.BOOK[down[0]].label, ok = api.BOOK[down[0] === 'draftkings' ? 'fanduel' : 'draftkings'].label; return set('', `<strong>${d} ${api.feedState(down[0]) === 'stale' ? 'stale' : 'reconnecting'}.</strong> Its prices may be old. ${ok} is still live; unavailable offers cannot win.`); }
  const r = ['draftkings', 'fanduel'].map((x) => st.sources[x]?.region).filter(Boolean);
  if (r.length === 2 && r[0] !== r[1]) return set('', `<strong>Different jurisdictions.</strong> DraftKings prices are from ${esc(r[0])}, FanDuel from ${esc(r[1])}.`);
  b.hidden = true;
}
function renderWire() {
  const moves = api.state.moves.slice(0, 6);
  if (!moves.length) { el.wire.innerHTML = '<div class="empty"><strong>No price moves yet.</strong>Lines are quiet midweek; they move constantly on Sundays and during live games.</div>'; return; }
  el.wire.innerHTML = `<ul class="wire-list">${moves.map((m) => {
    const lineMoved = m.prevLine != null && m.prevLine !== m.line;
    const from = lineMoved ? `${api.fmtLine(m.market, m.side, m.prevLine)} ${api.fmtOdds(m.prevOdds)}` : api.fmtOdds(m.prevOdds);
    const to = lineMoved ? `${api.fmtLine(m.market, m.side, m.line)} ${api.fmtOdds(m.odds)}` : api.fmtOdds(m.odds);
    const arrow = lineMoved ? '↔' : m.odds > m.prevOdds ? '↑' : '↓';
    return `<li class="move">${esc(m.game)} · ${esc(m.sideName)} ${esc(m.market === 'moneyline' ? 'Moneyline' : m.market === 'spread' ? 'Spread' : 'Total')}<span class="move-value"><s>${esc(from)}</s> ${arrow} ${esc(to)}</span><span class="move-source">${api.BOOK[m.book].label} · <time data-age-local="${m.at}">${esc(api.ago(m.at, Date.now()))}</time></span></li>`;
  }).join('')}</ul>`;
}
function countdown(t) {
  const s = (t - api.serverNow()) / 1000; if (s <= 0) return 'kicking off';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `in ${d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`}`;
}
function tick() {
  for (const n of root.querySelectorAll('[data-countdown]')) n.textContent = countdown(Number(n.dataset.countdown));
  if ((tick.n = (tick.n || 0) + 1) % 8 === 0) renderHolds(); // every 2 s
  for (const n of root.querySelectorAll('[data-age-ts]')) { const ts = Number(n.dataset.ageTs); n.textContent = `${n.dataset.agePrefix || ''}${api.ago(ts || null)}`; }
  for (const n of root.querySelectorAll('[data-age-local]')) n.textContent = api.ago(Number(n.dataset.ageLocal), Date.now());
  for (const n of root.querySelectorAll('[data-fresh]')) { const fr = api.freshness(n.dataset.fresh); n.style.width = `${(fr.fill * 100).toFixed(1)}%`; n.parentElement.setAttribute('aria-valuenow', String(Math.round(fr.fill * 100))); }
  // stale/connection state can change without a data event: refresh banner + feed classes + eligibility once a second
  const sig = ['draftkings', 'fanduel'].map(api.feedState).join('|') + api.state.connected;
  if (sig !== tick.sig) { tick.sig = sig; render(); }
}

export default { id: 'pressbox', name: 'Pressbox (light)', css: '/themes/pressbox.css',
  fonts: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap',
  mount, unmount, render, renderGame, renderFeeds, renderBanner, renderWire, renderExtras, renderExtrasToggles, renderHolds, focusSearch, toggleHelp, closeHelp, tick };
