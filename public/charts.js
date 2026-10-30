// Charts shared by both designs. They only draw: the data comes from the board core (app.js), the look from each
// theme's CSS (classes .bc-* for the big movement chart, .ld-* for the "more lines" ladder).
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const chance = (api, odds) => { const d = api.decimalOdds(odds); return d ? 100 / d : null; };
const BOOKS = ['draftkings', 'fanduel'];
export const RANGES = [['10m', '10 min', 10 * 60_000], ['1h', '1 hour', 3600_000], ['6h', '6 hours', 6 * 3600_000], ['1d', '1 day', 24 * 3600_000], ['1w', '1 week', 7 * 24 * 3600_000], ['all', 'All', null]];
const RMS = Object.fromEntries(RANGES.map(([id, , ms]) => [id, ms]));
const etFmt = (t, opts) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Toronto', ...opts });
const DENSE = 40; // more price changes than this in the window: no dot per change, the hover read-out gives the numbers

/** What one market/side is called on screen. */
export function pickName(g, pick) {
  const side = pick.market === 'total' ? (pick.side === 'over' ? 'Over' : 'Under') : g[pick.side].abbr;
  return pick.market === 'moneyline' ? `${side} to win` : pick.market === 'spread' ? `${side} spread` : `Total · ${side}`;
}

/**
 * Which window to show. Only windows the board has history for can be picked (the rest are greyed out); with no
 * choice made, a live game opens on the last hour and a game not started on the last day, or on All if that much
 * history does not exist yet.
 */
export function chartWindow(api, g, range, pick) {
  // history of the price being charted (so whichever window is shown, the box is filled from edge to edge)
  const now = api.serverNow(); const rec = pick ? api.seriesRange(g, pick.market, pick.side, 400 * 86400_000).recordedFrom : api.gameRecordedFrom(g) ?? now;
  const have = Math.max(0, now - (rec ?? now));
  const avail = (id) => id === 'all' || have >= RMS[id];
  let r = range && RMS[range] !== undefined && avail(range) ? range : null;
  if (!r) { const want = g.status === 'live' ? '1h' : '1d'; r = avail(want) ? want : 'all'; }
  return { id: r, ms: r === 'all' ? Math.max(have, 60_000) : RMS[r], have, avail, auto: !range || r !== range };
}
const dur = (ms) => (ms >= 2 * 86400_000 ? `${Math.floor(ms / 86400_000)} days` : ms >= 7200_000 ? `${Math.floor(ms / 3600_000)} hours` : `${Math.max(1, Math.round(ms / 60_000))} min`);

// hover read-out: the chart's data stays here (not in the page), keyed by game; the overlay is redrawn on every render
const HOVER = new Map(); let hoverAt = null; // { key, fx }
function priceAt(pts, t) { let lo = 0, hi = pts.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r < 0 ? null : pts[r]; }
function overlay(api, d, fx) {
  const t = d.from + fx * (d.to - d.from);
  const rows = d.books.map(({ b, pts }) => { const p = priceAt(pts, t); if (!p) return null; const c = chance(api, p[1]); return c == null ? null : { b, p, c, y: (1 - (c - d.lo) / (d.hi - d.lo)) * 100 }; }).filter(Boolean);
  if (!rows.length) return '';
  const side = fx > 0.62 ? `right:${((1 - fx) * 100).toFixed(2)}%;margin-right:14px` : `left:${(fx * 100).toFixed(2)}%;margin-left:14px`;
  const line = (p) => (d.market === 'moneyline' ? '' : ` ${esc(api.fmtLine(d.market, d.side, p[2]))}`);
  return `<span class="bh-line" style="left:${(fx * 100).toFixed(2)}%"></span>${rows.map((r) => `<i class="bh-dot ${api.BOOK[r.b].cls}" style="left:${(fx * 100).toFixed(2)}%;top:${r.y.toFixed(2)}%"></i>`).join('')}
    <div class="bh-box" style="${side}"><b>${esc(etFmt(t, { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</b>${rows.map((r) => `<span class="bh-row ${api.BOOK[r.b].cls}"><i></i>${api.BOOK[r.b].label} <strong>${esc(api.fmtOdds(r.p[1]))}</strong>${line(r.p)} · ${r.c.toFixed(1)}%</span>`).join('')}</div>`;
}
/** One listener per page root: pointer over a big chart shows each book's price at that moment (mouse, pen or touch). */
export function chartHover(root, api) {
  if (!root || root.dataset.chartHover) return; root.dataset.chartHover = '1';
  const show = (e) => {
    const lp = e.target.closest?.('.ld-plot[data-ladder-hover]');
    if (lp) { const r = lp.getBoundingClientRect(); ladderAt = { key: lp.dataset.ladderHover, fx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) }; const o = lp.querySelector('.bc-hover'); if (o) o.innerHTML = ladderOverlay(api, LADDER.get(ladderAt.key), ladderAt.fx); return; }
    const plot = e.target.closest?.('.bc-plot[data-hover]'); if (!plot) return;
    const d = HOVER.get(plot.dataset.hover); if (!d) return;
    const r = plot.getBoundingClientRect(); const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    hoverAt = { key: plot.dataset.hover, fx };
    const o = plot.querySelector('.bc-hover'); if (o) o.innerHTML = overlay(api, d, fx);
  };
  root.addEventListener('pointermove', show); root.addEventListener('pointerdown', show);
  root.addEventListener('pointerout', (e) => {
    const plot = e.target.closest?.('.bc-plot[data-hover], .ld-plot[data-ladder-hover]'); if (!plot || plot.contains(e.relatedTarget)) return;
    if (plot.matches('.ld-plot')) ladderAt = null; else hoverAt = null;
    const o = plot.querySelector('.bc-hover'); if (o) o.innerHTML = '';
  });
}

/** Spread / total: the line itself moves (−6.5 ↔ −7.5); a thin strip per book shows which line was up when. */
function lineStrip(api, pick, books, S, X, x0) {
  if (pick.market === 'moneyline') return '';
  const values = [...new Set(books.flatMap((b) => S.books[b].map((p) => p[2])).filter((v) => v != null))].sort((a, b) => a - b);
  if (values.length < 2) return '';
  const tint = (v) => Math.min(4, values.indexOf(v));
  const lane = (b) => {
    const pts = S.books[b]; if (!pts.length) return '';
    const segs = [];
    for (let i = 0; i < pts.length; i++) {
      const start = Math.max(X(pts[i][0]), x0), end = i + 1 < pts.length ? X(pts[i + 1][0]) : 1000;
      const last = segs[segs.length - 1]; if (last && last.v === pts[i][2]) last.end = end; else segs.push({ v: pts[i][2], start, end });
    }
    return `<div class="bc-lane"><span class="bc-lane-name ${api.BOOK[b].cls}">${api.BOOK[b].short}</span><div class="bc-lane-bar">${segs.filter((sg) => sg.end > sg.start).map((sg) => `<span class="bc-seg t${tint(sg.v)}" style="left:${(sg.start / 10).toFixed(2)}%;width:${((sg.end - sg.start) / 10).toFixed(2)}%">${sg.end - sg.start > 70 ? esc(api.fmtLine(pick.market, pick.side, sg.v)) : ''}</span>`).join('')}</div></div>`;
  };
  return `<div class="bc-lines" aria-label="Which line each book had up"><div class="bc-lines-key">Line: ${values.slice(0, 6).map((v) => `<span class="bc-seg-key t${tint(v)}">${esc(api.fmtLine(pick.market, pick.side, v))}</span>`).join('')}</div>${books.map(lane).join('')}</div>`;
}

/**
 * The big movement chart (a game's own page): each book's implied chance for one side over a chosen window, a step
 * line per book (a price holds until the next change). Few changes: a dot on each; many: lines only. Hover = exact
 * prices at that moment; for spreads and totals a strip below shows which line was up.
 */
export function bigChart(api, g, { pick, range }) {
  const W = chartWindow(api, g, range, pick); const ms = W.ms;
  const S = api.seriesRange(g, pick.market, pick.side, ms);
  const books = api.settings.view === 'best' ? BOOKS : [api.settings.view];
  const ranges = `<div class="bc-ranges" role="group" aria-label="Time window">${RANGES.map(([id, label]) => {
    const ok = W.avail(id);
    return `<button type="button" data-range="${id}" aria-pressed="${id === W.id}"${ok ? '' : ` disabled aria-disabled="true" title="${esc(`Not enough history yet: this board has ${dur(W.have)} of this price`)}"`}>${label}</button>`;
  }).join('')}</div>`;
  const picks = `<div class="bc-picks" role="group" aria-label="Which price to chart">${api.MARKETS.flatMap(([m, sides]) => sides.map((sd) => {
    const p = { market: m, side: sd }; const on = p.market === pick.market && p.side === pick.side;
    return `<button type="button" data-pick="${m}|${sd}" aria-pressed="${on}">${esc(pickName(g, p))}</button>`;
  })).join('')}</div>`;
  let lo = Infinity, hi = -Infinity, moves = 0;
  for (const b of books) { const pts = S.books[b]; moves += Math.max(0, pts.length - 1); for (const p of pts) { const v = chance(api, p[1]); if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } } }
  const now = books.map((b) => { const p = S.books[b]; const last = p[p.length - 1]; return last ? `<span class="bc-now ${api.BOOK[b].cls}"><i></i>${api.BOOK[b].label} <b>${esc(api.fmtOdds(last[1]))}</b>${pick.market === 'moneyline' ? '' : ` ${esc(api.fmtLine(pick.market, pick.side, last[2]))}`} · ${chance(api, last[1]).toFixed(1)}%</span>` : ''; }).join('');
  const head = `<div class="bc-head"><div><h3>${esc(pickName(g, pick))} <span>· implied chance</span></h3><div class="bc-legend">${now}</div></div>${ranges}</div>${picks}`;
  if (!Number.isFinite(lo)) { HOVER.delete(g.key); return `<section class="bc" aria-label="Price movement">${head}<p class="bc-empty">No price for this yet.</p></section>`; }
  // at least 5 points of chance on the axis, so a half-point wobble does not look like a crash
  const mid = (lo + hi) / 2, half = Math.max(((hi - lo) / 2) * 1.15, 2.5); lo = mid - half; hi = mid + half;
  const span = Math.max(1, S.to - S.from);
  const X = (t) => ((Math.min(Math.max(t, S.from), S.to) - S.from) / span) * 1000, Y = (v) => (1 - (v - lo) / (hi - lo)) * 300;
  // a window is offered only when the history covers all of it, so this shading is a safety net (clock skew)
  const gap = S.recordedFrom > S.from + span * 0.01 ? S.recordedFrom : null; const x0 = gap ? X(gap) : 0;
  const gapHtml = gap ? `<span class="bc-gap" style="width:${(x0 / 10).toFixed(2)}%"><em>${x0 > 180 ? `not recorded before ${esc(etFmt(gap, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}` : ''}</em></span>` : '';
  const dense = moves > DENSE;
  let paths = '', dots = '';
  for (const b of books) {
    const pts = S.books[b]; if (!pts.length) continue; const B = api.BOOK[b];
    let d = `M${Math.max(X(pts[0][0]), x0).toFixed(1)},${Y(chance(api, pts[0][1])).toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
      d += `H${X(pts[i][0]).toFixed(1)}V${Y(chance(api, pts[i][1])).toFixed(2)}`;
      if (dense) continue;
      const moved = pts[i][2] !== pts[i - 1][2] && pick.market !== 'moneyline';
      dots += `<i class="bc-dot ${B.cls}${moved ? ' is-line' : ''}" style="left:${(X(pts[i][0]) / 10).toFixed(2)}%;top:${(Y(chance(api, pts[i][1])) / 3).toFixed(2)}%"></i>`;
    }
    paths += `<path class="bc-line ${B.cls}" d="${d}H1000"/>`;
    const last = pts[pts.length - 1]; dots += `<i class="bc-end ${B.cls}" style="top:${(Y(chance(api, last[1])) / 3).toFixed(2)}%"></i>`;
  }
  HOVER.set(g.key, { from: S.from, to: S.to, lo, hi, market: pick.market, side: pick.side, books: books.map((b) => ({ b, pts: S.books[b] })) });
  const hov = hoverAt?.key === g.key ? overlay(api, HOVER.get(g.key), hoverAt.fx) : '';
  const yTicks = [0, 1, 2, 3, 4].map((i) => { const v = hi - ((hi - lo) * i) / 4; return `<span class="bc-y" style="top:${(i * 25).toFixed(1)}%">${v.toFixed(1)}%</span>`; }).join('');
  const grid = [1, 2, 3].map((i) => `<line x1="0" x2="1000" y1="${i * 75}" y2="${i * 75}"/>`).join('');
  const tf = ms <= 6 * 3600_000 ? { hour: 'numeric', minute: '2-digit' } : ms <= 24 * 3600_000 ? { weekday: 'short', hour: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' };
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span class="bc-x" style="left:${f * 100}%">${f === 1 ? 'now' : esc(etFmt(S.from + span * f, tf))}</span>`).join('');
  const winName = W.id === 'all' ? `all ${dur(ms)} recorded` : `the last ${RANGES.find((r) => r[0] === W.id)[1]}`;
  const label = `${pickName(g, pick)}, implied chance over ${winName}: ${moves} ${moves === 1 ? 'move' : 'moves'}. Point at the chart for the prices at any moment.`;
  const strip = lineStrip(api, pick, books, S, X, x0);
  return `<section class="bc" aria-label="Price movement">${head}
    <div class="bc-plot${dense ? ' is-dense' : ''}" data-hover="${esc(g.key)}" role="img" aria-label="${esc(label)}">${gapHtml}<svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true"><g class="bc-grid">${grid}</g>${paths}</svg>${dots}${yTicks}<div class="bc-hover" aria-hidden="true">${hov}</div></div>
    <div class="bc-axis">${xTicks}</div>${strip}
    <p class="bc-note"><b>${moves ? `${moves} price ${moves === 1 ? 'change' : 'changes'}` : 'No price change'}</b> in ${winName}.</p>
    <ul class="bc-tips"><li>Point at the chart for each book's price at that moment.</li>${strip ? "<li>The strip under it shows which line each book had up.</li>" : ''}<li>Greyed-out windows go back further than the board has recorded.</li></ul></section>`;
}

/**
 * The "more lines" ladder: for the bet type on screen, each book's implied chance at every line or threshold, so you
 * can see where one book is cheaper at a glance. Touchdown scorers: a bar per player and book instead.
 */
export function ladderChart(api, gk, v) {
  if (!v?.rows?.length) return '<aside class="ld"><p class="ld-empty">Nothing to chart yet.</p></aside>';
  const x = api.state.extras.get(gk) || {}; const g = api.state.games.get(gk);
  const B = api.BOOK;
  const legend = `<div class="ld-legend">${BOOKS.map((b) => `<span class="ld-key ${B[b].cls}"><i></i>${B[b].label}</span>`).join('')}</div>`;
  if (v.kind === 'td') {
    const rows = v.rows.filter((r) => r.cells.some(Boolean)).map((r) => ({ r, best: Math.max(...r.cells.filter(Boolean).map((o) => chance(api, o.odds))) })).sort((a, b) => b.best - a.best).slice(0, 12);
    const max = Math.max(...rows.map((x) => x.best), 1);
    return `<aside class="ld" aria-label="Anytime touchdown chances by book"><h4>Most likely scorers <span>· implied chance</span></h4>${legend}
      <ul class="ld-bars">${rows.map(({ r }) => `<li><span class="ld-name">${esc(r.name)}</span><span class="ld-pair">${r.cells.map((o, i) => o ? `<span class="ld-bar ${B[BOOKS[i]].cls}${r.cmp.best?.book === BOOKS[i] && r.cmp.kind === 'best' ? ' is-best' : ''}" style="width:${((chance(api, o.odds) / max) * 100).toFixed(1)}%" title="${B[BOOKS[i]].label} ${esc(api.fmtOdds(o.odds))}"><b>${chance(api, o.odds).toFixed(0)}%</b></span>` : '<span class="ld-bar is-none"></span>').join('')}</span></li>`).join('')}</ul>
      <p class="ld-note">Shorter bar at the same player = that book pays more.</p></aside>`;
  }
  // ladders: alt spread (one team), alt total (over/under), yardage / receptions (one player)
  let subjects, pickKey, title;
  if (v.kind === 'alt-spread' || v.kind === 'alt-total') {
    subjects = v.kind === 'alt-spread' ? [['away', g?.away.abbr || 'Away'], ['home', g?.home.abbr || 'Home']] : [['over', 'Over'], ['under', 'Under']];
    pickKey = subjects.some(([id]) => id === x.ladder) ? x.ladder : subjects[0][0];
    title = v.kind === 'alt-spread' ? `${subjects.find((s) => s[0] === pickKey)[1]} at every spread` : `${pickKey === 'over' ? 'Over' : 'Under'} at every total`;
  } else {
    const names = [...new Set(v.rows.map((r) => r.name))];
    subjects = names.map((n) => [n, n]);
    pickKey = names.includes(x.ladder) ? x.ladder : names[0];
    title = `${pickKey} at every threshold`;
  }
  const rows = v.rows.filter((r) => (v.kind === 'alt-spread' || v.kind === 'alt-total' ? r.subject === pickKey : r.name === pickKey)).sort((a, b) => a.line - b.line);
  const chooser = subjects.length > 6
    ? `<select class="ld-select" data-ladder-select aria-label="Player">${subjects.map(([id, l]) => `<option value="${esc(id)}"${id === pickKey ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
    : `<div class="ld-subjects" role="group">${subjects.map(([id, l]) => `<button type="button" data-ladder="${esc(id)}" aria-pressed="${id === pickKey}">${esc(l)}</button>`).join('')}</div>`;
  if (!rows.length) return `<aside class="ld"><h4>${esc(title)}</h4>${chooser}<p class="ld-empty">No lines for this one.</p></aside>`;
  const W = 600, H = 220, n = rows.length;
  const X = (i) => (n === 1 ? W / 2 : 24 + (i * (W - 48)) / (n - 1)), Y = (p) => H - 12 - (p / 100) * (H - 24);
  // same rules as the big chart: lines only (a dot per number only when there are few), point at it for the prices,
  // and a strip underneath says which book pays more at each number
  let paths = '', marks = ''; const few = n <= 12;
  BOOKS.forEach((b, bi) => {
    let d = ''; rows.forEach((r, i) => {
      const o = r.cells[bi]; if (!o) return; const p = chance(api, o.odds);
      d += `${d ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p).toFixed(1)}`;
      if (few) marks += `<circle class="ld-pt ${B[b].cls}" cx="${X(i).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="3"/>`;
    });
    if (d) paths += `<path class="ld-line ${B[b].cls}" d="${d}"/>`;
  });
  const lineName = (r) => (v.kind === 'alt-spread' ? `${r.subject === 'away' ? g?.away.abbr : g?.home.abbr} ${api.fmtLine('spread', r.subject, r.line)}` : v.kind === 'alt-total' ? `${r.subject === 'over' ? 'Over' : 'Under'} ${r.line}` : `${r.name} ${r.line}+`);
  const winner = (r) => (r.cmp.kind === 'best' ? B[r.cmp.best.book].cls : r.cmp.kind === 'tie' ? 'tie' : 'none');
  const edge = (i) => (n === 1 ? [0, 100] : [Math.max(0, (X(i) - (W - 48) / (n - 1) / 2) / W) * 100, Math.min(W, X(i) + (W - 48) / (n - 1) / 2) / W * 100]);
  const strip = `<div class="ld-best" role="img" aria-label="Which book pays more at each number">${rows.map((r, i) => { const [a, z] = edge(i); return `<span class="ld-win ${winner(r)}" style="left:${a.toFixed(2)}%;width:${(z - a).toFixed(2)}%"></span>`; }).join('')}</div>
    <div class="ld-best-key"><span class="ld-win-key dk"></span>${B.draftkings.label} pays more<span class="ld-win-key fd"></span>${B.fanduel.label} pays more<span class="ld-win-key tie"></span>same price</div>`;
  LADDER.set(gk, { n, W, H, X, Y, rows: rows.map((r) => ({ name: lineName(r), cells: r.cells, win: r.cmp.kind === 'best' ? r.cmp.best.book : r.cmp.kind })) });
  const hov = ladderAt?.key === gk ? ladderOverlay(api, LADDER.get(gk), ladderAt.fx) : '';
  const every = Math.max(1, Math.ceil(n / 7));
  // the last number is always labelled; the regular label just before it is dropped when the two would touch
  const lastReg = Math.floor((n - 1) / every) * every; const dropReg = lastReg !== n - 1 && (n - 1 - lastReg) < every * 0.75;
  const ticks = rows.map((r, i) => ((i % every === 0 && !(dropReg && i === lastReg)) || i === n - 1 ? `<span class="ld-x" style="left:${((X(i) / W) * 100).toFixed(2)}%">${esc(v.kind === 'alt-spread' ? api.fmtLine('spread', r.subject, r.line) : v.kind === 'alt-total' ? r.line : `${r.line}+`)}</span>` : '')).join('');
  return `<aside class="ld" aria-label="${esc(title)}"><h4>${esc(title)} <span>· implied chance</span></h4>${chooser}${legend}
    <div class="ld-plot" data-ladder-hover="${esc(gk)}"><svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><g class="ld-grid">${[25, 50, 75].map((p) => `<line x1="0" x2="${W}" y1="${Y(p)}" y2="${Y(p)}"/>`).join('')}</g>${paths}${marks}</svg>
      ${[100, 75, 50, 25, 0].map((p) => `<span class="ld-y" style="top:${((Y(p) / H) * 100).toFixed(1)}%">${p}%</span>`).join('')}<div class="bc-hover" aria-hidden="true">${hov}</div></div>
    <div class="ld-axis">${ticks}</div>${strip}
    <p class="ld-note">Point at the chart for both books' prices at a number. Where one line sits lower, that book pays more; the strip shows it at every number.</p></aside>`;
}

// ladder hover: snaps to the nearest number
const LADDER = new Map(); let ladderAt = null;
function ladderOverlay(api, d, fx) {
  if (!d) return '';
  const i = d.n === 1 ? 0 : Math.min(d.n - 1, Math.max(0, Math.round(((fx * d.W) - 24) / ((d.W - 48) / (d.n - 1)))));
  const r = d.rows[i]; const left = (d.X(i) / d.W) * 100;
  const cells = BOOKS.map((b, bi) => { const o = r.cells[bi]; if (!o) return null; const c = chance(api, o.odds); return { b, o, c, y: (d.Y(c) / d.H) * 100 }; }).filter(Boolean);
  const verdict = r.win === 'draftkings' || r.win === 'fanduel' ? `${api.BOOK[r.win].label} pays more` : r.win === 'tie' ? 'same price' : 'only one book';
  const side = left > 55 ? `right:${(100 - left).toFixed(2)}%;margin-right:12px` : `left:${left.toFixed(2)}%;margin-left:12px`;
  return `<span class="bh-line" style="left:${left.toFixed(2)}%"></span>${cells.map((x) => `<i class="bh-dot ${api.BOOK[x.b].cls}" style="left:${left.toFixed(2)}%;top:${x.y.toFixed(2)}%"></i>`).join('')}
    <div class="bh-box" style="${side}"><b>${esc(r.name)}</b>${cells.map((x) => `<span class="bh-row ${api.BOOK[x.b].cls}"><i></i>${api.BOOK[x.b].label} <strong>${esc(api.fmtOdds(x.o.odds))}</strong> · ${x.c.toFixed(1)}%</span>`).join('')}<em class="bh-verdict">${verdict}</em></div>`;
}
