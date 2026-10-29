// Opens the board the way viewers do — every league, both designs, desktop and phone, light and dark — and reports
// anything that went wrong: script errors, console errors, failed or 4xx/5xx requests, a board with no prices,
// horizontal scrolling on a phone. Exit code 1 if anything is found.
// Usage: node tools/site-check.mjs [url]
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'https://nfl-odds-board-hgim.onrender.com').replace(/\/$/, '');
const LEAGUES = ['nfl', 'ncaaf', 'cfl'];
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
  page.on('pageerror', (e) => mine.push(`script error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') mine.push(`console: ${m.text().slice(0, 160)}`); });
  page.on('response', (r) => { if (r.status() >= 400) mine.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => { const err = r.failure()?.errorText || ''; if (!/ERR_ABORTED/.test(err)) mine.push(`request failed: ${r.url()} ${err}`); });
  const t0 = Date.now();
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // prices on screen = a price cell (either design) or the "no games" message for a league without games this week
  const shown = await page.waitForFunction(() => document.querySelector('.odds, .g-table td[data-market]') || /No games|Neither book/.test(document.body.innerText), null, { timeout: 30_000 }).then(() => true).catch(() => false);
  const firstPrices = Date.now() - t0;
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => ({
    prices: document.querySelectorAll('.odds, .g-table td[data-market]').length,
    stale: /stale|reconnecting/i.test(document.querySelector('#connection-banner:not([hidden]), #g-banner:not([hidden])')?.innerText || ''),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    title: document.querySelector('h1, .g-sub')?.innerText || '',
  }));
  if (!shown) mine.push('nothing rendered within 30 s');
  if (info.stale) mine.push('a "stale / reconnecting" banner is showing');
  if (view.isMobile && info.overflowX) mine.push('page scrolls sideways on a phone');
  for (const p of mine) problems.push(`${label}: ${p}`);
  notes.push(`${label.padEnd(34)} ${String(info.prices).padStart(4)} prices · first prices ${firstPrices} ms · ${mine.length ? `${mine.length} problem(s)` : 'ok'}`);
  await ctx.close();
}

for (const lg of LEAGUES) for (const theme of ['pressbox', 'grid']) for (const view of VIEWS) {
  const q = new URLSearchParams(); if (lg !== 'nfl') q.set('league', lg); if (theme !== 'pressbox') q.set('theme', theme);
  await check(`/${q.size ? `?${q}` : ''}`, view, `${lg} · ${theme} · ${view.name}`);
}
await check('/?scheme=dark', VIEWS[0], 'nfl · pressbox · desktop · dark');
await check('/?theme=grid&scheme=dark', VIEWS[0], 'nfl · grid · desktop · dark');
// every league's first game on its own page (big chart, time windows), both designs
for (const lg of LEAGUES) {
  const games = (await (await fetch(`${BASE}/api/board?league=${lg}`)).json()).games || []; if (!games.length) continue;
  const key = encodeURIComponent(games[0].key);
  for (const theme of ['pressbox', 'grid']) for (const view of VIEWS) await check(`/?league=${lg}&game=${key}${theme === 'grid' ? '&theme=grid' : ''}`, view, `${lg} · game page · ${theme} · ${view.name}`);
}
{ // open a game from the list by its chart, change the window, come back with Esc
  const ctx = await browser.newContext({ viewport: VIEWS[0].viewport }); const page = await ctx.newPage(); const mine = [];
  page.on('pageerror', (e) => mine.push(`script error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.chart[data-open-game]', { timeout: 30_000 });
  await page.locator('.chart[data-open-game]').first().click(); await page.waitForSelector('.bc', { timeout: 10_000 }).catch(() => mine.push('no big chart after clicking a chart'));
  if (!page.url().includes('game=')) mine.push('the game page has no link of its own');
  await page.click('[data-range="1w"]').catch(() => mine.push('no 1 week button')); await page.waitForTimeout(500);
  if (await page.locator('[data-range="1w"][aria-pressed="true"]').count() !== 1) mine.push('1 week window did not select');
  await page.keyboard.press('Escape'); await page.waitForTimeout(800);
  if (page.url().includes('game=') || !(await page.locator('.game').count())) mine.push('Esc did not return to all games');
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
  const h1 = await page.locator('h1').innerText(); if (!/College/.test(h1)) mine.push(`heading after switching league: "${h1}"`);
  if (!page.url().includes('league=ncaaf')) mine.push('the link does not keep the league');
  const single = page.locator('[data-singles]'); if (await single.count()) { await single.first().click(); await page.waitForTimeout(500); }
  await page.click('[data-league="nfl"]'); await page.waitForTimeout(3000);
  if (!/NFL/.test(await page.locator('h1').innerText())) mine.push('could not switch back to NFL');
  for (const p of mine) problems.push(`league switch: ${p}`);
  notes.push(`league switch in the page${' '.repeat(10)}${mine.length ? `${mine.length} problem(s)` : 'ok'}`);
  await ctx.close();
}
await browser.close();
console.log(notes.join('\n'));
if (problems.length) { console.log(`\n✖ ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`); process.exit(1); }
console.log('\n✔ no errors');
