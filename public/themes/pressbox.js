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
      <div class="mast-links"><a href="${REPO}#readme">How it works</a><span class="demo-label">Ontario prices · DraftKings + FanDuel · live</span>${picker}</div>
    </header>
    <section class="heading">
      <div><h1>NFL / <span>odds.</span></h1><p class="subtitle">Live and pregame · All kickoff times ET.</p></div>
      <div class="view" role="group" aria-label="Sportsbook view">
        <button type="button" data-view="best">Best price</button><button type="button" data-view="draftkings">DraftKings only</button><button type="button" data-view="fanduel">FanDuel only</button>
      </div>
    </section>
    <div class="toolbar" aria-label="Board controls">
      <div class="field phase-field"><span id="phase-label">Game status</span><div class="segment" role="group" aria-labelledby="phase-label">
        <button type="button" data-phase="all">All</button><button type="button" data-phase="live">Live</button><button type="button" data-phase="pregame">Pregame</button></div></div>
      <label class="field search">Find a team<input id="search" type="search" autocomplete="off" placeholder="Team or abbreviation"></label>
      <label class="field">Odds format<select id="odds-format"><option value="american">American</option><option value="decimal">Decimal</option></select></label>
    </div>
    <p class="source-note">Ontario prices from DraftKings and FanDuel. Every number updates on its own; nothing here is simulated.</p>
    <div class="sticky">
      <div id="connection-banner" class="banner loading"><strong>Connecting to sportsbooks…</strong> Waiting for the first complete snapshot.</div>
      <div class="feeds" id="feeds"></div>
      <div class="columns" style="--markets:3"><span>GAME</span><span>SPREAD</span><span>TOTAL</span><span>MONEYLINE</span></div>
    </div>
    <div class="results" id="results"></div>
    <main id="board" class="games"></main>
    <section class="wire" aria-label="Recent price moves"><h2>The wire.</h2><div id="wire"></div></section>
    <footer class="footer">
      <p>The higher odds win only when both books offer the same line and both prices are live and open. Equal prices are a tie; different lines are never ranked.</p>
      <a href="${REPO}#readme">How it works ↗</a>
    </footer>
  </div>`;
  el = { board: root.querySelector('#board'), feeds: root.querySelector('#feeds'), banner: root.querySelector('#connection-banner'), results: root.querySelector('#results'), wire: root.querySelector('#wire') };
  root.querySelectorAll('.view button').forEach((b) => b.addEventListener('click', () => api.set('view', b.dataset.view)));
  root.querySelectorAll('.segment button').forEach((b) => b.addEventListener('click', () => api.set('phase', b.dataset.phase)));
  root.querySelector('#search').addEventListener('input', (e) => api.set('search', e.target.value));
  const fmt = root.querySelector('#odds-format'); fmt.value = api.settings.format; fmt.addEventListener('change', (e) => api.set('format', e.target.value));
  root.querySelector('#theme-picker')?.addEventListener('change', (e) => api.setTheme(e.target.value));
}
function unmount() { root.innerHTML = ''; }

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
  const head = (extra, q) => `<div class="${cls} ${extra}" role="group" aria-label="${esc(`${g.away.abbr} @ ${g.home.abbr} · ${label}`)}"${tag(q)} style="${pos}"><span class="market-label">${esc(label)}</span>`;
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
    return `${head(`is-best ${stateClass(ch)}`, q)}<div class="quote">${lineHtml(q)}<strong class="odds">${esc(api.fmtOdds(q.odds))}</strong>${changeHtml(q, ch)}</div>
      <div class="compare"><span class="book ${B[q.book].cls}">${B[q.book].label}</span><span class="separator">·</span><span class="other"><span class="book ${B[other.book].cls}">${B[other.book].short}</span> ${esc(api.fmtOdds(other.odds))}</span></div>${lineNotice(q, ch)}</div>`;
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
  return `<div class="game-meta">${meta}</div><div class="match" style="--markets:3">${teamHtml(g.away, 'away')}${cells(0)}${teamHtml(g.home, 'home')}${cells(1)}</div>`;
}

// ---------- sections ----------
function render() {
  root.querySelectorAll('.view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === api.settings.view)));
  root.querySelectorAll('.segment button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.phase === api.settings.phase)));
  const groups = api.groups();
  const total = groups.reduce((n, g) => n + g.games.length, 0), live = groups.find((g) => g.live)?.games.length || 0;
  el.results.innerHTML = `<span>${total} ${total === 1 ? 'game' : 'games'} shown · ${live} live</span><span>${api.settings.format === 'decimal' ? 'Decimal' : 'American'} odds</span>`;
  if (!api.state.everConnected) el.board.innerHTML = '';
  else if (!total) el.board.innerHTML = `<div class="empty"><strong>No games match.</strong>${api.settings.search || api.settings.phase !== 'all' ? 'Clear the search or choose All to see every game.' : 'Neither book has NFL game lines up right now; the board fills itself as soon as one does.'}</div>`;
  else el.board.innerHTML = groups.map((grp) => `<section class="kickoff-group"><h2 class="kickoff">${grp.live ? '<span class="live-tag">● Live</span> In progress' : esc(etTime(grp.start, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + etTime(grp.start, { hour: 'numeric', minute: '2-digit' }) + ' ET')}<span class="group-count">${grp.games.length} ${grp.games.length === 1 ? 'game' : 'games'}</span></h2>
      ${grp.games.map((g) => `<article class="game" aria-label="${esc(`${g.away.abbr} @ ${g.home.abbr}`)}" data-game="${esc(g.key)}">${gameInner(g)}</article>`).join('')}</section>`).join('');
  renderFeeds(); renderBanner(); renderWire();
}
function renderGame(key) {
  const g = api.state.games.get(key); const node = el.board.querySelector(`[data-game="${CSS.escape(key)}"]`);
  if (!g || !node) return;
  node.innerHTML = gameInner(g);
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
function tick() {
  for (const n of root.querySelectorAll('[data-age-ts]')) { const ts = Number(n.dataset.ageTs); n.textContent = `${n.dataset.agePrefix || ''}${api.ago(ts || null)}`; }
  for (const n of root.querySelectorAll('[data-age-local]')) n.textContent = api.ago(Number(n.dataset.ageLocal), Date.now());
  for (const n of root.querySelectorAll('[data-fresh]')) { const fr = api.freshness(n.dataset.fresh); n.style.width = `${(fr.fill * 100).toFixed(1)}%`; n.parentElement.setAttribute('aria-valuenow', String(Math.round(fr.fill * 100))); }
  // stale/connection state can change without a data event: refresh banner + feed classes + eligibility once a second
  const sig = ['draftkings', 'fanduel'].map(api.feedState).join('|') + api.state.connected;
  if (sig !== tick.sig) { tick.sig = sig; render(); }
}

export default { id: 'pressbox', name: 'Pressbox (light)', css: '/themes/pressbox.css',
  fonts: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap',
  mount, unmount, render, renderGame, renderFeeds, renderBanner, renderWire, tick };
