// The top bar, shared by both designs: the same header, controls and words, in the same place (the original Pressbox
// header). Row 1: name, design switch, region, how it works, light/dark, keyboard help. Then the league title with the
// price view (best / one book) beside it, then League · Show · Find a team · Odds.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function topbarHtml(api, repo) {
  const design = api.themes.length > 1 ? `<div class="tb-design"><span id="tb-design-l">Design</span><div class="tb-seg tb-solid" role="group" aria-labelledby="tb-design-l">${api.themes.map((t) => `<button type="button" data-theme-switch="${t.id}">${esc(t.short || t.name)}</button>`).join('')}</div></div>` : '';
  return `<header class="tb">
    <div class="tb-mast">
      <div class="tb-mast-left"><span class="tb-wordmark">PRESSBOX / ODDS</span>${design}</div>
      <div class="tb-links"><span class="tb-demo">Ontario · DraftKings + FanDuel · live</span><a href="${repo}#readme">How it works</a>
        <button type="button" class="tb-icon" id="tb-scheme" title="Light / dark (d)" aria-label="Switch light or dark"></button>
        <button type="button" class="tb-icon" id="tb-help" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-expanded="false">?</button></div>
    </div>
    <section class="tb-heading">
      <div><h1 id="tb-title"></h1><p class="tb-subtitle">Best price across DraftKings and FanDuel, live. Kickoffs in ET.</p></div>
      <div class="tb-view" role="group" aria-label="Prices from"><button type="button" data-view="best">Best price</button><button type="button" data-view="draftkings">DraftKings only</button><button type="button" data-view="fanduel">FanDuel only</button></div>
    </section>
    <div class="tb-toolbar" aria-label="Board controls">
      <div class="tb-field tb-league"><span id="tb-league-l">League</span><div class="tb-seg" role="group" aria-labelledby="tb-league-l" id="tb-leagues"></div></div>
      <div class="tb-field tb-phase"><span id="tb-phase-l">Show</span><div class="tb-seg" role="group" aria-labelledby="tb-phase-l"><button type="button" data-phase="all">All</button><button type="button" data-phase="live">Live</button><button type="button" data-phase="pregame">Pregame</button><button type="button" data-phase="starred">★ Starred</button></div></div>
      <label class="tb-field tb-searchf"><span>Find a team <kbd>/</kbd></span><input id="tb-search" type="search" autocomplete="off" placeholder="Search teams"></label>
      <div class="tb-field tb-format"><span id="tb-format-l">Odds</span><div class="tb-seg" role="group" aria-labelledby="tb-format-l"><button type="button" data-format="american">American</button><button type="button" data-format="decimal">Decimal</button></div></div>
    </div>
  </header>`;
}

export function wireTopbar(root, api, { toggleHelp } = {}) {
  const bar = root.querySelector('.tb');
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.themeSwitch) return api.setTheme(b.dataset.themeSwitch);
    if (b.dataset.league) return api.setLeague(b.dataset.league);
    if (b.dataset.view) return api.set('view', b.dataset.view);
    if (b.dataset.phase) return api.set('phase', b.dataset.phase);
    if (b.dataset.format) return api.set('format', b.dataset.format);
    if (b.id === 'tb-scheme') return api.set('scheme', document.documentElement.dataset.scheme === 'dark' ? 'light' : 'dark');
    if (b.id === 'tb-help') return toggleHelp?.();
  });
  bar.querySelector('#tb-search').addEventListener('input', (e) => api.set('search', e.target.value));
}

export function renderTopbar(root, api) {
  const bar = root.querySelector('.tb'); if (!bar) return;
  const title = `${esc(api.league().title)} / <span>odds.</span>`; const h = bar.querySelector('#tb-title'); if (h.innerHTML !== title) h.innerHTML = title;
  const leagues = api.leagueOptions().map((l) => `<button type="button" data-league="${l.id}" aria-pressed="${l.id === api.settings.league}" title="${esc(l.title)}">${esc(l.label)}${l.games != null ? ` <small>${l.games}</small>` : ''}</button>`).join('');
  const L = bar.querySelector('#tb-leagues'); if (L.innerHTML !== leagues) L.innerHTML = leagues;
  const press = (sel, on) => bar.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(on(b))));
  press('[data-theme-switch]', (b) => b.dataset.themeSwitch === api.settings.theme);
  press('[data-view]', (b) => b.dataset.view === api.settings.view);
  press('[data-phase]', (b) => b.dataset.phase === api.settings.phase);
  press('[data-format]', (b) => b.dataset.format === api.settings.format);
  const dark = document.documentElement.dataset.scheme === 'dark'; const s = bar.querySelector('#tb-scheme');
  s.textContent = dark ? '☀' : '☾'; s.setAttribute('aria-label', dark ? 'Switch to light' : 'Switch to dark');
  const input = bar.querySelector('#tb-search'); if (document.activeElement !== input && input.value !== api.settings.search) input.value = api.settings.search;
}
