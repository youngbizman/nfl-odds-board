// BetMGM browser session: one headless Chromium that opens BetMGM's own NFL page and asks BetMGM's odds API from
// inside that page, the same request the page makes itself.
//
// Why a browser: BetMGM's odds API (www.betmgm.ca/cds-api/…) answers 403 to plain HTTP clients, even from a home IP in
// Ontario; it serves the page's own requests. So the worker is a real browser session, not an imitation of one.
// What it costs: one Chromium (~150–250 MB). What it gives: the same answers BetMGM's page gets, slimmed inside the
// page to the few fields the board reads (a few KB instead of ~0.5 MB per request).
//
// The public access key (x-bwin-accessid) is read from the page's own first API request, never hard-coded, so a key
// rotation costs a page reload, not a code change.
// Memory: BetMGM's full page keeps ~470 MB of Chromium busy. Once it has made its first API request (so the session and
// key exist), the worker opens a tiny page of the same site (robots.txt) in the same session and closes the heavy one:
// ~230 MB, and the API calls work the same (same site, same session). MGM_LIGHT=0 keeps the full page instead.
import { slimFixtures } from './betmgm.js';

export const MGM_PAGE = 'https://www.betmgm.ca/en/sports/football-11/betting/usa-9/nfl-35';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BLOCK = new Set(['image', 'font', 'media', 'stylesheet']);

export class BetMGMBrowser {
  constructor({ log = () => {}, pageUrl = process.env.MGM_PAGE_URL || MGM_PAGE, reloadMs = 30 * 60_000 } = {}) {
    this.log = log; this.pageUrl = pageUrl; this.reloadMs = reloadMs;
    this.browser = null; this.page = null; this.api = null; this.accessId = null; this.openedAt = 0; this.opening = null;
    this.stats = { opens: 0, requests: 0, errors: 0, lastMs: null, lastBytes: null };
  }

  /** Open (or reuse) the session. Resolves once the page has made its first API request (so we know key + host). */
  open() {
    if (this.page && Date.now() - this.openedAt < this.reloadMs) return Promise.resolve();
    if (!this.opening) this.opening = this._open().finally(() => { this.opening = null; });
    return this.opening;
  }

  async _open() {
    await this.close();
    const { chromium } = await import('playwright'); // lazy: the server runs without Playwright when BetMGM is off
    this.browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox', '--disable-extensions', '--renderer-process-limit=2', '--js-flags=--max-old-space-size=128'] });
    const ctx = await this.browser.newContext({ userAgent: UA, locale: 'en-CA', timezoneId: 'America/Toronto', viewport: { width: 1280, height: 800 }, bypassCSP: true });
    await ctx.route('**/*', (route) => (BLOCK.has(route.request().resourceType()) ? route.abort() : route.continue()));
    const page = await ctx.newPage();
    const found = new Promise((resolve) => {
      page.on('request', (req) => {
        const u = req.url(); if (!u.includes('/cds-api/')) return;
        const url = new URL(u); const key = url.searchParams.get('x-bwin-accessid');
        if (key && !this.accessId) { this.accessId = key; this.api = `${url.origin}/cds-api`; resolve(); }
      });
    });
    this.accessId = null;
    await page.goto(this.pageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await Promise.race([found, new Promise((_, rej) => setTimeout(() => rej(new Error('BetMGM page made no API request in 30 s')), 30_000))]);
    let use = page;
    if (process.env.MGM_LIGHT !== '0') { // swap the heavy page for a tiny one of the same site, same session
      use = await ctx.newPage();
      await use.goto(`${new URL(this.api).origin}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.close();
    }
    this.page = use; this.openedAt = Date.now(); this.stats.opens++;
    this.log('mgm', `browser session open (${this.api}, key ${this.accessId.slice(0, 6)}…)`);
  }

  fixturesUrl(competitionId) {
    const q = new URLSearchParams({ 'x-bwin-accessid': this.accessId, lang: 'en-us', country: 'CA', userCountry: 'CA', subdivision: 'CA-Ontario',
      fixtureTypes: 'Standard', state: 'Latest', offerMapping: 'Filtered', offerCategories: 'Gridable', fixtureCategories: 'Gridable,NonGridable,Other',
      sportIds: '11', competitionIds: String(competitionId), isPriceBoost: 'false', skip: '0', take: '100', sortBy: 'Tags' });
    return `${this.api}/bettingoffer/fixtures?${q}`;
  }

  /** One league's fixtures, slimmed in the page ({ raw: true }: unslimmed, for recording test fixtures).
   *  Throws an Error with .status on a non-200 answer. */
  async fetchFixtures(competitionId, { raw = false } = {}) {
    await this.open();
    const t0 = Date.now();
    const expr = `(async () => {
      const slim = ${slimFixtures.toString()};
      const r = await fetch(${JSON.stringify(this.fixturesUrl(competitionId))}, { headers: { accept: 'application/json, text/plain, */*' }, credentials: 'include' });
      const text = await r.text();
      if (r.status !== 200) return { status: r.status, bytes: text.length, retryAfter: r.headers.get('retry-after') };
      return { status: 200, bytes: text.length, data: ${raw ? 'JSON.parse(text)' : 'slim(JSON.parse(text))'} };
    })()`;
    let out;
    try { out = await this.page.evaluate(expr); }
    catch (e) { this.stats.errors++; this.page = null; throw e; } // page crashed or navigated: reopen next time
    this.stats.requests++; this.stats.lastMs = Date.now() - t0; this.stats.lastBytes = out.bytes;
    if (out.status !== 200) {
      this.stats.errors++;
      if (out.status === 401 || out.status === 403) this.page = null; // session refused: a fresh page next time
      const err = new Error(`HTTP ${out.status}`); err.status = out.status; err.retryAfterMs = Number(out.retryAfter) * 1000 || 0; throw err;
    }
    return out.data;
  }

  async close() { const b = this.browser; this.browser = null; this.page = null; if (b) await b.close().catch(() => {}); }
}
