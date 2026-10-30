// The top bar, shared by both designs: the same name, the same controls with the same words, in the same place.
// Row 1: who we are, the design switch, light/dark, keyboard help, how it works.
// Row 2: what the board shows: league, team search, which prices (best / one book), live/pregame/starred, odds format.
// On a phone row 2 keeps league and search; the rest opens with "Filters".
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function topbarHtml(api, repo) {
  const design = api.themes.length > 1 ? `<div class="tb-seg tb-design" role="group" aria-label="Design">${api.themes.map((t) => `<button type="button" data-theme-switch="${t.id}">${esc(t.short || t.name)}</button>`).join('')}</div>` : '';
  return `<header class="tb">
    <div class="tb-row">
      <h1 class="sr" id="tb-title"></h1>
      <div class="tb-brand"><span class="tb-logo" aria-hidden="true"></span><b>Odds Board</b><span class="tb-sub">Ontario · DraftKings vs FanDuel · live</span></div>
      <div class="tb-right">${design}
        <div class="tb-icons"><button type="button" class="tb-icon" id="tb-scheme" title="Light / dark (d)" aria-label="Switch light or dark"></button><button type="button" class="tb-icon" id="tb-help" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-expanded="false">?</button><a class="tb-icon" href="${repo}#readme" title="How it works" aria-label="How it works">i</a></div>
      </div>
    </div>
    <div class="tb-row tb-controls">
      <div class="tb-seg" role="group" aria-label="League" id="tb-leagues"></div>
      <label class="tb-search"><span class="sr">Find a team</span><input id="tb-search" type="search" autocomplete="off" placeholder="Search teams"></label>
      <button type="button" class="tb-filters" id="tb-filters" aria-expanded="false" aria-controls="tb-more">Filters</button>
      <div class="tb-more" id="tb-more">
        <div class="tb-seg" role="group" aria-label="Prices from"><button type="button" data-view="best">Best price</button><button type="button" data-view="draftkings">DraftKings</button><button type="button" data-view="fanduel">FanDuel</button></div>
        <div class="tb-seg" role="group" aria-label="Show"><button type="button" data-phase="all">All</button><button type="button" data-phase="live">Live</button><button type="button" data-phase="pregame">Pregame</button><button type="button" data-phase="starred">★ Starred</button></div>
        <div class="tb-seg" role="group" aria-label="Odds format"><button type="button" data-format="american">American</button><button type="button" data-format="decimal">Decimal</button></div>
      </div>
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
    if (b.id === 'tb-filters') { const open = !bar.classList.contains('is-open'); bar.classList.toggle('is-open', open); b.setAttribute('aria-expanded', String(open)); }
  });
  bar.querySelector('#tb-search').addEventListener('input', (e) => api.set('search', e.target.value));
}

export function renderTopbar(root, api) {
  const bar = root.querySelector('.tb'); if (!bar) return;
  const leagues = api.leagueOptions().map((l) => `<button type="button" data-league="${l.id}" aria-pressed="${l.id === api.settings.league}" title="${esc(l.title)}">${esc(l.label)}${l.games != null ? ` <small>${l.games}</small>` : ''}</button>`).join('');
  const L = bar.querySelector('#tb-leagues'); if (L.innerHTML !== leagues) L.innerHTML = leagues;
  const title = `${api.league().title} odds: DraftKings vs FanDuel`; const h = bar.querySelector('#tb-title'); if (h.textContent !== title) h.textContent = title; // for screen readers
  const press = (sel, on) => bar.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(on(b))));
  press('[data-theme-switch]', (b) => b.dataset.themeSwitch === api.settings.theme);
  press('[data-view]', (b) => b.dataset.view === api.settings.view);
  press('[data-phase]', (b) => b.dataset.phase === api.settings.phase);
  press('[data-format]', (b) => b.dataset.format === api.settings.format);
  const dark = document.documentElement.dataset.scheme === 'dark'; const s = bar.querySelector('#tb-scheme');
  s.textContent = dark ? '☀' : '☾'; s.setAttribute('aria-label', dark ? 'Switch to light' : 'Switch to dark');
  // a filter that is on shows on the Filters button (phone), so a hidden choice is never forgotten
  const on = [api.settings.view !== 'best', api.settings.phase !== 'all'].filter(Boolean).length;
  bar.querySelector('#tb-filters').textContent = on ? `Filters · ${on}` : 'Filters';
  const input = bar.querySelector('#tb-search'); if (document.activeElement !== input && input.value !== api.settings.search) input.value = api.settings.search;
}
