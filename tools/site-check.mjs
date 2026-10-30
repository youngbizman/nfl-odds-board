// Opens the board the way viewers do — every league, both designs, desktop and phone, light and dark — and reports
// anything that went wrong: script errors, console errors, failed or 4xx/5xx requests, a board with no prices,
// horizontal scrolling on a phone, an address that is not a plain one (no #fragment, no %-codes, no ?game=), a tab title
// that does not name the page. Exit code 1 if anything is found.
// Usage: node tools/site-check.mjs [url]
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'https://nfl-odds-board-hgim.onrender.com').replace(/\/$/, '');
const LEAGUES = ['nfl', 'ncaaf', 'cfl', 'all'];
const PATH = { nfl: '/', ncaaf: '/college-football', cfl: '/cfl', all: '/all' };
const NAME = { nfl: 'NFL', ncaaf: 'College Football', cfl: 'CFL', all: 'All Leagues' };
// a plain address: a board or a game page, then only display choices (?design=engineering&theme=dark&view=…&range=…)
const CLEAN = /^\/(?:(?:college-football|cfl|all)|(?:nfl|college-football|cfl)\/[a-z0-9]+(?:-[a-z0-9]+)*-at-[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2})?(?:\?(?:design|theme|view|range)=[a-z0-9]+(?:&(?:design|theme|view|range)=[a-z0-9]+)*)?$/;
const where = (page) => { const u = new URL(page.url()); return u.pathname + u.search + u.hash; };
const plain = (page) => CLEAN.test(where(page));
const VIEWS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];
const problems = []; const notes = [];
// bundled Chromium if installed, otherwise the machine's own Chrome
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: 'chrome' }));

async function check(path, view, label) {
  const ctx = await browser.newContext({ viewport: view.viewport, isMobile: view.isMobile, hasTouch: view.hasTouch });
  const page = await ctx.newPage(); const mine = [];
  // the site sends a Content-Security-Policy: any resource or script it blocks is reported here as a problem
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP blocked ${e.violatedDirective}: ${e.blockedURI}`)));
  page.on('pageerror', (e) => mine.push(`script error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') mine.push(`console: ${m.text().slice(0, 160)}`); });
  page.on('response', (r) => { if (r.status() >= 400) mine.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => { const err = r.failure()?.errorText || ''; if (!/ERR_ABORTED/.test(err)) mine.push(`request failed: ${r.url()} ${err}`); });
  const t0 = Date.now();
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // prices on screen = a price cell (either design) or the "no games" message for a league without games this week
  // polled with evaluate (Playwright's waitForFunction evaluates a string in the page, which the site's CSP rightly forbids)
  let shown = false;
  for (const end = Date.now() + 30_000; !shown && Date.now() < end;) { shown = await page.evaluate(() => !!(document.querySelector('.odds, .g-table td[data-market]') || /No games|Neither book/.test(document.body.innerText))).catch(() => false); if (!shown) await page.waitForTimeout(150); }
  const firstPrices = Date.now() - t0;
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => ({
    prices: document.querySelectorAll('.odds, .g-table td[data-market]').length,
    stale: /stale|reconnecting/i.test(document.querySelector('#connection-banner:not([hidden]), #g-banner:not([hidden])')?.innerText || ''),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    // no scroll box inside the page, sideways or up-down: the page itself is the only thing that scrolls
    boxes: [...document.querySelectorAll('body *')].filter((e) => { const cs = getComputedStyle(e); return (['auto', 'scroll'].includes(cs.overflowX) && e.scrollWidth > e.clientWidth + 1) || (['auto', 'scroll'].includes(cs.overflowY) && e.scrollHeight > e.clientHeight + 1); }).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`).slice(0, 3),
    title: document.querySelector('h1, .g-sub')?.innerText || '',
    tab: document.title,
  }));
  if (!plain(page)) mine.push(`address is not a plain one: ${where(page)}`);
  if (view.expectTab && !info.tab.includes(view.expectTab)) mine.push(`tab title "${info.tab}" does not say ${view.expectTab}`);
  if (!shown) mine.push('nothing rendered within 30 s');
  if (info.stale) mine.push('a "stale / reconnecting" banner is showing');
  if (info.overflowX) mine.push(`page scrolls sideways (${view.name})`);
  if (info.boxes.length) mine.push(`a scroll box inside the page: ${info.boxes.join(', ')}`);
  for (const p of mine) problems.push(`${label}: ${p}`);
  notes.push(`${label.padEnd(34)} ${String(info.prices).padStart(4)} prices · first prices ${firstPrices} ms · ${mine.length ? `${mine.length} problem(s)` : 'ok'}`);
  await ctx.close();
}

for (const lg of LEAGUES) for (const theme of ['pressbox', 'grid']) for (const view of VIEWS) {
  await check(`${PATH[lg]}${theme === 'grid' ? '?design=engineering' : ''}`, { ...view, expectTab: `${NAME[lg]} Odds Board` }, `${lg} · ${theme} · ${view.name}`);
}
await check('/?theme=dark', VIEWS[0], 'nfl · pressbox · desktop · dark');
await check('/?design=engineering&theme=dark', VIEWS[0], 'nfl · grid · desktop · dark');
// every league's first game on its own page (big chart, time windows), both designs, from the link the board itself shows
const gameLinks = {};
{
  const ctx = await browser.newContext({ viewport: VIEWS[0].viewport }); const page = await ctx.newPage();
  for (const lg of LEAGUES.filter((l) => l !== 'all')) {
    await page.goto(`${BASE}${PATH[lg]}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[data-open-game]', { timeout: 20_000 }).catch(() => {});
    const a = page.locator('a[data-open-game]').first(); if (!(await a.count())) continue;
    gameLinks[lg] = { href: await a.getAttribute('href'), name: (await a.innerText()).replace(/\s*›\s*$/, '').trim() };
    if (!CLEAN.test(gameLinks[lg].href)) problems.push(`${lg}: a game link is not a plain address: ${gameLinks[lg].href}`);
  }
  await ctx.close();
}
for (const [lg, { href }] of Object.entries(gameLinks)) {
  for (const theme of ['pressbox', 'grid']) for (const view of VIEWS) await check(`${href}${theme === 'grid' ? '?design=engineering' : ''}`, { ...view, expectTab: `· ${NAME[lg]} Odds Board` }, `${lg} · game page · ${theme} · ${view.name}`);
}
// addresses: old links land on the plain one, /nfl and trailing slashes redirect, anything else is a real 404
{
  const ctx = await browser.newContext({ viewport: VIEWS[0].viewport }); const page = await ctx.newPage(); const mine = [];
  const land = async (from, want) => {
    await page.goto(`${BASE}${from}`, { waitUntil: 'domcontentloaded' });
    for (const end = Date.now() + 15_000; Date.now() < end && where(page) !== want;) await page.waitForTimeout(200);
    if (where(page) !== want) mine.push(`${from} → ${where(page)} (expected ${want})`);
  };
  await land('/nfl', '/'); await land('/cfl/', '/cfl'); await land('/college-football/?design=engineering', '/college-football?design=engineering');
  await land('/?league=ncaaf&theme=grid&scheme=dark', '/college-football?design=engineering&theme=dark');
  const nf = await page.goto(`${BASE}/no-such-page`); if (nf.status() !== 404 || !/Page not found/.test(await page.content())) mine.push(`/no-such-page: HTTP ${nf.status()} (expected a 404 page)`);
  const api404 = await page.goto(`${BASE}/api/no-such-thing`); if (api404.status() !== 404) mine.push(`/api/no-such-thing: HTTP ${api404.status()}`);
  for (const p of mine) problems.push(`addresses: ${p}`);
  notes.push(`addresses (old links, redirects, 404)${' '.repeat(Math.max(1, 36 - 'addresses (old links, redirects, 404)'.length))}${mine.length ? `${mine.length} problem(s)` : 'ok'}`);
  await ctx.close();
}
{ // open a game from the list by its chart, change the window, come back with Esc
  const ctx = await browser.newContext({ viewport: VIEWS[0].viewport }); const page = await ctx.newPage(); const mine = [];
  page.on('pageerror', (e) => mine.push(`script error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.chart[data-open-game]', { timeout: 30_000 });
  await page.locator('.chart[data-open-game]').first().click(); await page.waitForSelector('.bc', { timeout: 10_000 }).catch(() => mine.push('no big chart after clicking a chart'));
  const gameUrl = where(page);
  if (!/^\/(nfl|college-football|cfl)\/[a-z0-9-]+$/.test(new URL(page.url()).pathname) || !plain(page)) mine.push(`the game page has no plain link of its own: ${gameUrl}`);
  if (!/· NFL Odds Board$/.test(await page.title())) mine.push(`game page tab title: "${await page.title()}"`);
  // windows longer than the board's history are greyed out; All and any open window must select
  for (const r of ['all', '10m']) {
    const b = page.locator(`[data-range="${r}"]:not([disabled])`); if (!(await b.count())) { if (r === 'all') mine.push('no All button'); continue; }
    await b.click(); await page.waitForTimeout(400);
    if (await page.locator(`[data-range="${r}"][aria-pressed="true"]`).count() !== 1) mine.push(`the ${r} window did not select`);
  }
  { const plot = page.locator('.bc-plot'); await plot.evaluate((e) => e.scrollIntoView({ block: 'center' })).catch(() => {}); await page.waitForTimeout(300); const bb = await plot.boundingBox(); if (bb) { await page.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5); await page.waitForTimeout(200); if (!(await page.locator('.bh-box').count())) mine.push('no price read-out when pointing at the chart'); } }
  if (!/[?&]range=/.test(where(page)) || !plain(page)) mine.push(`choosing a window did not show in the address: ${where(page)}`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(800);
  if (where(page) !== '/' || !(await page.locator('.game').count())) mine.push(`Esc did not return to all games (address ${where(page)})`);
  // Back returns to the game, Forward/Back again to the list, and the address follows
  await page.goBack(); await page.waitForTimeout(1200);
  if (new URL(page.url()).pathname !== new URL(gameUrl, BASE).pathname || !(await page.locator('.bc').count())) mine.push(`Back did not reopen the game (address ${where(page)})`);
  await page.goBack(); await page.waitForTimeout(1200);
  if (where(page) !== '/' || !(await page.locator('.game').count())) mine.push(`Back again did not return to the list (address ${where(page)})`);
  for (const p of mine) problems.push(`game page: ${p}`);
  notes.push(`open a game from its chart${' '.repeat(9)}${mine.length ? `${mine.length} problem(s)` : 'ok'}`);
  await ctx.close();
}
// the league switch inside the page (no reload) and the single-book toggle
{
  const ctx = await browser.newContext({ viewport: VIEWS[0].viewport }); const page = await ctx.newPage(); const mine = [];
  page.on('pageerror', (e) => mine.push(`script error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('[data-league="ncaaf"]', { timeout: 30_000 });
  await page.click('[data-league="ncaaf"]'); await page.waitForTimeout(3000);
  if (!(await page.locator('[data-league="ncaaf"][aria-pressed="true"]').count())) mine.push('the College button is not selected after switching league');
  const h1 = await page.locator('h1').first().textContent(); if (!/College/.test(h1 || '')) mine.push(`heading after switching league: "${h1}"`);
  if (where(page) !== '/college-football') mine.push(`the address after switching league: ${where(page)}`);
  if (await page.title() !== 'College Football Odds Board') mine.push(`tab title after switching league: "${await page.title()}"`);
  const single = page.locator('[data-singles]'); if (await single.count()) { await single.first().click(); await page.waitForTimeout(500); }
  await page.click('[data-league="nfl"]'); await page.waitForTimeout(3000);
  if (!(await page.locator('[data-league="nfl"][aria-pressed="true"]').count()) || !/NFL/.test((await page.locator('h1').first().textContent()) || '')) mine.push('could not switch back to NFL');
  if (where(page) !== '/' || await page.title() !== 'NFL Odds Board') mine.push(`back on NFL: address ${where(page)}, tab "${await page.title()}"`);
  // design, dark and price view show up in the address as plain words
  await page.click('[data-theme-switch="grid"]'); await page.waitForTimeout(800); await page.click('#tb-scheme'); await page.click('[data-view="fanduel"]'); await page.waitForTimeout(500);
  if (where(page) !== '/?design=engineering&theme=dark&view=fanduel') mine.push(`address after design + dark + FanDuel: ${where(page)}`);
  for (const p of mine) problems.push(`league switch: ${p}`);
  notes.push(`league switch in the page${' '.repeat(10)}${mine.length ? `${mine.length} problem(s)` : 'ok'}`);
  await ctx.close();
}
await browser.close();
console.log(notes.join('\n'));
if (problems.length) { console.log(`\n✖ ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`); process.exit(1); }
console.log('\n✔ no errors');
