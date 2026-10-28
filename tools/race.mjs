// Side-by-side check of our board against the books' OWN websites, in real Chrome windows on one machine (one clock).
//
//   left window : DraftKings website  | FanDuel website      (what a bettor on the book's site sees)
//   right window: our board, DK view  | our board, FD view
//
// 1) Correctness: every DraftKings / FanDuel price on our board vs the latest value the book's own page has.
// 2) Race: for every price change, when did the book's page receive it, and when did our board paint it?
//    delta = our paint − book page receive.  Negative = our board showed it BEFORE the book's own website.
//    (Book page "receive" is measured at the network layer, i.e. before the book even paints it: this favours the book.)
//
// Usage: node tools/race.mjs [boardUrl] [minutes]
import fs from 'node:fs';
import { chromium } from 'playwright';
import { decode } from '@msgpack/msgpack';
import { BoardStore } from '../src/store.js';
import { Metrics } from '../src/metrics.js';
import { DraftKingsSource, familyOf, lineFromId } from '../src/sources/draftkings.js';
import { FanDuelSource } from '../src/sources/fanduel.js';
import { parseAmerican } from '../src/model.js';

const BOARD = (process.argv[2] || 'https://nfl-odds-board-hgim.onrender.com').replace(/\/$/, '');
const MINUTES = Number(process.argv[3] || 20);
const OUT = `research/race/${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ARGS = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

// ---- what each book's own page knows, keyed like our board: gameKey|market|side|book ----
const site = { draftkings: new Map(), fanduel: new Map() }; // key -> { odds, line, t }
const siteChanges = [];                                     // { book, key, odds, line, t }
const dk = new DraftKingsSource(new BoardStore(), new Metrics(), () => {});
const fd = new FanDuelSource(new BoardStore(), new Metrics(), () => {});
function siteValue(book, key, odds, line, t) {
  const prev = site[book].get(key);
  site[book].set(key, { odds, line, t });
  if (prev && (prev.odds !== odds || prev.line !== line)) siteChanges.push({ book, key, odds, line, prevOdds: prev.odds, prevLine: prev.line, t });
}
const k = (ref, book) => `${ref.gameKey}|${ref.market}|${ref.side}|${book}`;

const left = await chromium.launch({ channel: 'chrome', headless: false, args: [...ARGS, '--window-position=0,30', '--window-size=760,880'] });
const right = await chromium.launch({ channel: 'chrome', headless: false, args: [...ARGS, '--window-position=760,30', '--window-size=760,880'] });
const lctx = await left.newContext({ viewport: null, locale: 'en-CA', timezoneId: 'America/Toronto' });
const rctx = await right.newContext({ viewport: null, locale: 'en-CA', timezoneId: 'America/Toronto' });

// DraftKings website: its snapshot request and every WebSocket frame it receives
const dkPage = await lctx.newPage();
dkPage.on('response', async (r) => {
  if (!r.url().includes('sportscontent/controldata/league/leagueSubcategory')) return;
  try {
    const j = await r.json(); const t = Date.now();
    dk.applySnapshot(j, t);
    for (const s of j.selections || []) { const ref = dk.selIndex.get(s.id); if (ref) siteValue('draftkings', k(ref, 'draftkings'), parseAmerican(s.displayOdds?.american), ref.market === 'moneyline' ? null : (s.points ?? lineFromId(s.id)), t); }
    log('DK site snapshot', j.selections?.length, 'selections');
  } catch {}
});
let dkFrames = 0;
dkPage.on('websocket', (ws) => ws.on('framereceived', (f) => {
  const t = Date.now(); dkFrames++;
  let m; try { m = decode(Buffer.isBuffer(f.payload) ? f.payload : Buffer.from(f.payload)); } catch { return; }
  const walk = (a) => { if (!Array.isArray(a)) return;
    if (typeof a[0] === 'string' && Array.isArray(a[2]) && typeof a[2][0] === 'string' && /^[+−-]?\d+$/.test(a[2][0])) {
      const ref = dk.selIndex.get(a[0]) || dk.familyIndex.get(familyOf(a[0]));
      if (ref) siteValue('draftkings', k(ref, 'draftkings'), parseAmerican(a[2][0]), ref.market === 'moneyline' ? null : (typeof a[4] === 'number' ? a[4] : lineFromId(a[0])), t);
    }
    for (const x of a) walk(x); };
  if (Array.isArray(m) && m[1] === 'update') walk(m[2]);
}));

// FanDuel website: its page-model snapshot and every getMarketPrices poll it makes
const fdPage = await lctx.newPage();
let fdPolls = 0;
fdPage.on('response', async (r) => {
  const u = r.url();
  try {
    if (u.includes('content-managed-page') && u.includes('customPageId=nfl')) {
      const j = await r.json(); const t = Date.now(); fd.applySnapshot(j, t);
      for (const m of Object.values(j.attachments?.markets || {})) for (const rn of m.runners || []) {
        const ref = fd.selIndex.get(`${m.marketId}:${rn.selectionId}`);
        if (ref) siteValue('fanduel', k(ref, 'fanduel'), parseAmerican(rn.winRunnerOdds?.americanDisplayOdds?.americanOdds), ref.market === 'moneyline' ? null : rn.handicap ?? null, t);
      }
      log('FD site snapshot', fd.marketIds.length, 'game-line markets');
    } else if (u.includes('getMarketPrices')) {
      const j = await r.json(); const t = Date.now(); fdPolls++;
      for (const m of j) for (const rd of m.runnerDetails || []) {
        const ref = fd.selIndex.get(`${m.marketId}:${rd.selectionId}`);
        if (ref) siteValue('fanduel', k(ref, 'fanduel'), parseAmerican(rd.winRunnerOdds?.americanDisplayOdds?.americanOdds), ref.market === 'moneyline' ? null : rd.handicap ?? null, t);
      }
    }
  } catch {}
});

// Our board: record the moment a price cell's value changes on screen
const RECORDER = () => {
  window.__seen = new Map(); window.__changes = [];
  const scan = () => { const t = Date.now();
    for (const el of document.querySelectorAll('[data-q]')) {
      const key = el.dataset.q, v = `${el.dataset.odds}|${el.dataset.line}`, prev = window.__seen.get(key);
      if (prev !== undefined && prev !== v) window.__changes.push({ key, odds: el.dataset.odds === '' ? null : Number(el.dataset.odds), line: el.dataset.line === '' ? null : Number(el.dataset.line), t });
      window.__seen.set(key, v);
    } };
  // observe `document` (it exists when init scripts run; documentElement may not yet)
  new MutationObserver(scan).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-odds', 'data-line'] });
};
const ourDk = await rctx.newPage(); await ourDk.addInitScript(RECORDER);
const ourFd = await rctx.newPage(); await ourFd.addInitScript(RECORDER);

await Promise.all([
  dkPage.goto('https://sportsbook.draftkings.com/leagues/football/nfl', { waitUntil: 'domcontentloaded', timeout: 60000 }),
  fdPage.goto('https://sportsbook.fanduel.com/navigation/nfl', { waitUntil: 'domcontentloaded', timeout: 60000 }),
  ourDk.goto(`${BOARD}/?view=draftkings`, { waitUntil: 'domcontentloaded' }),
  ourFd.goto(`${BOARD}/?view=fanduel`, { waitUntil: 'domcontentloaded' }),
]);
await dkPage.bringToFront(); await ourDk.bringToFront();
await new Promise((r) => setTimeout(r, 15000));

// ---------- 1) correctness ----------
async function boardValues(page) { return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-q]')].map((e) => [e.dataset.q, { odds: e.dataset.odds === '' ? null : Number(e.dataset.odds), line: e.dataset.line === '' ? null : Number(e.dataset.line) }]))); }
async function compare(book, page) {
  const ours = await boardValues(page); const res = { book, compared: 0, match: 0, mismatch: [], missingOnBoard: [], boardOnly: 0 };
  for (const [key, v] of site[book]) {
    const o = ours[key]; if (!o) { res.missingOnBoard.push(key); continue; }
    res.compared++;
    if (o.odds === v.odds && o.line === v.line) res.match++; else res.mismatch.push({ key, site: v, board: o, siteAgeMs: Date.now() - v.t });
  }
  res.boardOnly = Object.keys(ours).filter((x) => !site[book].has(x)).length;
  return res;
}
const show = (r) => log(`${r.book.padEnd(10)} compared ${r.compared} · identical ${r.match} · different ${r.mismatch.length} · on site but not on board ${r.missingOnBoard.length} · on board but site page has no value yet ${r.boardOnly}`);
let c1 = [await compare('draftkings', ourDk), await compare('fanduel', ourFd)];
c1.forEach(show);
// differences may just be one side being fresher; look again after the FanDuel page's next poll cycle
if (c1.some((r) => r.mismatch.length)) { await new Promise((r) => setTimeout(r, 7000)); c1 = [await compare('draftkings', ourDk), await compare('fanduel', ourFd)]; log('re-check after 7 s:'); c1.forEach(show); }
for (const r of c1) for (const m of r.mismatch.slice(0, 8)) log('   diff', m.key, 'site', m.site.line, m.site.odds, `(${Math.round(m.siteAgeMs / 1000)} s old)`, 'board', m.board.line, m.board.odds);
for (const [p, name] of [[dkPage, 'dk-site'], [fdPage, 'fd-site'], [ourDk, 'board-dk'], [ourFd, 'board-fd']]) await p.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});

// ---------- 2) race ----------
log(`racing for ${MINUTES} min … (DK site frames so far ${dkFrames}, FD site polls ${fdPolls})`);
const end = Date.now() + MINUTES * 60_000; let lastReport = 0;
while (Date.now() < end) { await new Promise((r) => setTimeout(r, 5000)); if (Date.now() - lastReport > 60_000) { lastReport = Date.now(); log(`site changes seen: DK ${siteChanges.filter((c) => c.book === 'draftkings').length}, FD ${siteChanges.filter((c) => c.book === 'fanduel').length} · FD site polls ${fdPolls}`); } }
const ours = [...(await ourDk.evaluate(() => window.__changes)).map((c) => ({ ...c, book: 'draftkings' })), ...(await ourFd.evaluate(() => window.__changes)).map((c) => ({ ...c, book: 'fanduel' }))];

const pairs = [], siteOnly = [], boardOnly = [];
const used = new Set();
for (const s of siteChanges) {
  const m = ours.find((o, i) => !used.has(i) && o.key === s.key && o.odds === s.odds && o.line === s.line && o.t >= s.t - 30_000 && o.t <= s.t + 30_000);
  if (m) { used.add(ours.indexOf(m)); pairs.push({ ...s, boardT: m.t, deltaMs: m.t - s.t }); } else siteOnly.push(s);
}
ours.forEach((o, i) => { if (!used.has(i)) boardOnly.push(o); });
const stat = (a) => { if (!a.length) return 'n=0'; const x = a.map((p) => p.deltaMs).sort((p, q) => p - q); const q = (f) => x[Math.min(x.length - 1, Math.floor(f * x.length))]; return `n=${x.length} · median ${q(0.5)} ms · min ${x[0]} · max ${x[x.length - 1]} · board first in ${x.filter((d) => d < 0).length}/${x.length}`; };
log('RACE (our paint − book page receive; negative = our board first)');
log('  DraftKings', stat(pairs.filter((p) => p.book === 'draftkings')));
log('  FanDuel   ', stat(pairs.filter((p) => p.book === 'fanduel')));
for (const p of pairs) log(`   ${p.book === 'draftkings' ? 'DK' : 'FD'} ${p.key.split('|').slice(0, 3).join(' ')} ${p.prevOdds}→${p.odds}: book page ${new Date(p.t).toISOString().slice(11, 23)}, our board ${p.deltaMs >= 0 ? '+' : ''}${p.deltaMs} ms`);
log(`  changes the book page got but our board never showed: ${siteOnly.length}  ·  board changes the book page never got (book page did not poll that market, or we were fresher): ${boardOnly.length}`);
const c2 = [await compare('draftkings', ourDk), await compare('fanduel', ourFd)]; log('final correctness:'); c2.forEach(show);
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify({ board: BOARD, minutes: MINUTES, correctnessStart: c1, correctnessEnd: c2, pairs, siteOnly, boardOnly, dkFrames, fdPolls }, null, 1));
log('saved', OUT);
await left.close(); await right.close();
