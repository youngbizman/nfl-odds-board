// Watches the deployed board through a live window and writes what happened, so a game night can be measured with no
// laptop involved (runs on a GitHub Actions machine: .github/workflows/live-test.yml).
//
// For the whole window it listens to every league's stream like a viewer and, every 10 minutes, it records:
//   * how often prices really moved, per league and book (changes per minute)
//   * how fast: DraftKings publish → this machine; server → this machine (both clock-corrected against /api/time);
//     the server's own figures (DraftKings publish → server, FanDuel's updatedAt → server, push vs poll per league)
//   * correctness: every price on the board vs what each book's own API serves at that moment, by the book's event id
//   * health: both books fresh, no restart (uptime keeps growing), the self keep-alive working
//   * the page itself (tools/site-check.mjs) at the start and once mid-window
// Output: <outDir>/samples.jsonl (one line per sample) and <outDir>/summary.md, pushed to the `live-results` branch.
// Usage: node tools/live-watch.mjs <url> <outDir> [startET=19:20] [endET=22:20]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeHttp } from '../src/transport/http.js';

const BASE = (process.argv[2] || 'https://nfl-odds-board-hgim.onrender.com').replace(/\/$/, '');
const OUT = process.argv[3] || 'research/live/out';
const [START, END] = [process.argv[4] || '19:20', process.argv[5] || '22:20'];
const LEAGUES = ['nfl', 'ncaaf', 'cfl'];
const PUSH = process.env.LIVE_WATCH_PUSH === '1';
fs.mkdirSync(OUT, { recursive: true });

const etParts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value]));
const etClock = (d = new Date()) => { const p = etParts(d); return `${p.hour}:${p.minute}:${p.second}`; };
const etMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const nowEtMinutes = () => { const p = etParts(); return Number(p.hour) * 60 + Number(p.minute); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const log = (...a) => console.log(etClock(), ...a);
const getJson = async (p) => (await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(30_000) })).json();

// ---------- clock: offset of the server's clock from ours (NTP-style, best of 5) ----------
let offset = 0;
async function syncClock() {
  let best = null;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now(); let serverTs; try { ({ serverTs } = await getJson('/api/time')); } catch { continue; } const t1 = Date.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, off: serverTs - (t0 + t1) / 2 };
  }
  if (best) offset = best.off; return best;
}
const serverNow = () => Date.now() + offset;

// ---------- streams: one per league, like three viewers ----------
const blank = () => ({ changes: { draftkings: 0, fanduel: 0 }, delivery: [], dkE2E: [], reconnects: 0 });
let win = Object.fromEntries(LEAGUES.map((l) => [l, blank()]));
const totals = Object.fromEntries(LEAGUES.map((l) => [l, { draftkings: 0, fanduel: 0 }]));
let stopping = false;
async function listen(lg) {
  while (!stopping) {
    try {
      const res = await fetch(`${BASE}/api/stream?league=${lg}`); const dec = new TextDecoder(); let buf = '';
      for await (const c of res.body) {
        if (stopping) break;
        buf += dec.decode(c, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!/^event: batch/m.test(block)) continue;
          const d = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || '{}'); const now = serverNow();
          for (const q of d.quotes || []) {
            if (!((q.prevOdds != null && q.prevOdds !== q.odds) || (q.prevLine != null && q.prevLine !== q.line))) continue;
            win[lg].changes[q.book]++; totals[lg][q.book]++;
            const del = now - q.updatedAt; if (del > -2000 && del < 60_000) win[lg].delivery.push(del);
            if (q.book === 'draftkings' && q.sourceTs) { const e = now - q.sourceTs; if (e > -2000 && e < 120_000) win[lg].dkE2E.push(e); }
          }
        }
      }
    } catch {}
    if (!stopping) { win[lg].reconnects++; await sleep(2000); }
  }
}

// ---------- correctness: board vs each book's API, by the book's own event id ----------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const dkH = { accept: 'application/json', referer: 'https://sportsbook.draftkings.com/', origin: 'https://sportsbook.draftkings.com', 'user-agent': UA, 'x-client-name': 'web', 'x-client-version': '2643.4.1.10' };
const fdH = { accept: 'application/json', referer: 'https://on.sportsbook.fanduel.ca/', 'user-agent': UA, 'x-sportsbook-region': 'ON', 'x-application': 'FhMFpcPWXMeyZxOx' };
const IDS = { nfl: ['88808', 'nfl'], ncaaf: ['87637', 'ncaaf'], cfl: ['33567', 'cfl'] };
const dkUrl = (id) => `https://sportsbook-nash.draftkings.com/sites/CA-ON-SB/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?${new URLSearchParams({ isBatchable: 'false', templateVars: id, include: 'Events', entity: 'events', eventsQuery: `$filter=leagueId eq '${id}' AND clientMetadata/Subcategories/any(s: s/Id eq '4518')`, marketsQuery: "$filter=clientMetadata/subCategoryId eq '4518' AND tags/all(t: t ne 'SportcastBetBuilder')" })}`;
const fdUrl = (p) => `https://sbapi.on.sportsbook.fanduel.ca/api/content-managed-page?page=CUSTOM&customPageId=${p}&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FToronto`;
const MK = { Moneyline: 'moneyline', Spread: 'spread', Total: 'total', MONEY_LINE: 'moneyline', 'MATCH_HANDICAP_(2-WAY)': 'spread', 'TOTAL_POINTS_(OVER/UNDER)': 'total' };
const num = (v) => (v == null ? null : Number(String(v).replace('−', '-').replace('+', '')));
const http = makeHttp({ log: () => {} });
async function compare(lg) {
  const [dkId, fdPage] = IDS[lg];
  const [board, dk, fd] = await Promise.all([getJson(`/api/board?league=${lg}`), http.getJson(dkUrl(dkId), dkH, 20_000).catch((e) => ({ error: e.message })), fetch(fdUrl(fdPage), { headers: fdH, signal: AbortSignal.timeout(20_000) }).then((r) => r.json()).catch((e) => ({ error: e.message }))]);
  const q = new Map(board.quotes.map((x) => [x.id, x])); const byEvent = { draftkings: new Map(), fanduel: new Map() };
  for (const g of board.games) for (const b of ['draftkings', 'fanduel']) if (g.books?.[b]?.eventId) byEvent[b].set(String(g.books[b].eventId), g);
  const res = { draftkings: { same: 0, diff: 0, missing: 0, liveDiff: 0, error: dk.error || null }, fanduel: { same: 0, diff: 0, missing: 0, liveDiff: 0, error: fd.error || null } };
  const cmp = (b, g, market, side, odds, line) => {
    const r = res[b]; const x = q.get(`${g.key}|${market}|${side}|${b}`);
    if (!x) { r.missing++; return; }
    if (x.odds === odds && (market === 'moneyline' || x.line === line)) r.same++; else { r.diff++; if (g.status === 'live') r.liveDiff++; }
  };
  const dkM = new Map((dk.markets || []).map((m) => [m.id, m]));
  for (const s of dk.selections || []) {
    const m = dkM.get(s.marketId); const market = MK[m?.name]; if (!market) continue; const g = byEvent.draftkings.get(String(m.eventId));
    if (!g) { res.draftkings.missing++; continue; }
    cmp('draftkings', g, market, market === 'total' ? (s.outcomeType || s.label).toLowerCase() : s.outcomeType?.toLowerCase(), num(s.displayOdds?.american), market === 'moneyline' ? null : s.points);
  }
  for (const m of Object.values(fd.attachments?.markets || {})) {
    const market = MK[m.marketType]; if (!market) continue; const g = byEvent.fanduel.get(String(m.eventId));
    if (!g) { res.fanduel.missing += m.runners?.length || 0; continue; }
    for (const r of m.runners || []) cmp('fanduel', g, market, r.result?.type?.toLowerCase(), num(r.winRunnerOdds?.americanDisplayOdds?.americanOdds), market === 'moneyline' ? null : r.handicap);
  }
  return { live: board.games.filter((g) => g.status === 'live').map((g) => `${g.away.abbr} @ ${g.home.abbr}`), ...res };
}

// ---------- the page ----------
function siteCheck() {
  const r = spawnSync(process.execPath, ['tools/site-check.mjs', BASE], { encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, summary: out.split('\n').slice(-3).join(' / ').slice(0, 400), full: out };
}

// ---------- one sample ----------
const samples = []; let lastUptime = null, restarts = 0; const siteChecks = [];
async function sample(withCompare) {
  const clock = await syncClock().catch(() => null);
  const [m, h] = await Promise.all([getJson('/api/metrics'), getJson('/api/health')]);
  if (lastUptime != null && m.uptimeSec < lastUptime) restarts++; lastUptime = m.uptimeSec;
  const minutes = samples.length ? (Date.now() - samples.at(-1).t) / 60000 : null;
  const streams = Object.fromEntries(LEAGUES.map((lg) => { const w = win[lg]; return [lg, { changes: w.changes, perMin: minutes ? { draftkings: +(w.changes.draftkings / minutes).toFixed(1), fanduel: +(w.changes.fanduel / minutes).toFixed(1) } : null,
    serverToHere: { p50: pct(w.delivery, 0.5), p90: pct(w.delivery, 0.9), n: w.delivery.length }, dkPublishToHere: { p50: pct(w.dkE2E, 0.5), p90: pct(w.dkE2E, 0.9), n: w.dkE2E.length }, reconnects: w.reconnects }]; }));
  win = Object.fromEntries(LEAGUES.map((l) => [l, blank()]));
  const s = {
    t: Date.now(), et: etClock(), version: m.version, uptimeSec: m.uptimeSec, restarts, clockRttMs: clock?.rtt ?? null,
    health: { ok: h.ok, leagues: h.leagues, books: Object.fromEntries(Object.entries(h.books).map(([b, v]) => [b, { stale: v.stale, state: v.state, mode: v.mode, push: v.push, transport: v.transport, dataAgeMs: v.dataAgeMs }])) },
    server: {
      dkPublishToServer: { live: m.draftkings.ingestLagLive, pregame: m.draftkings.ingestLagPregame, clockOffsetMs: m.draftkings.clockOffsetMs },
      dkSnapshotMs: m.draftkings.snapshotMs, fdPoll: m.fanduel.pollDuration, fdPushLag: m.fanduel.pushLag, fdByLeague: m.fanduel.byLeague, fdPushNoChange: m.fanduel.pushNoChange,
      fdMarketsMissing: m.fanduel.marketsMissing, fdPush: m.transport?.fanduelPush, keepalive: m.keepalive, viewers: m.sse?.clients,
    },
    streams,
  };
  if (withCompare) s.compare = Object.fromEntries(await Promise.all(LEAGUES.map(async (lg) => [lg, await compare(lg).catch((e) => ({ error: e.message }))])));
  samples.push(s); fs.appendFileSync(path.join(OUT, 'samples.jsonl'), JSON.stringify(s) + '\n');
  log(`sample: v${s.version} up ${s.uptimeSec}s restarts ${restarts} · ` + LEAGUES.map((lg) => `${lg} DK ${streams[lg].changes.draftkings} FD ${streams[lg].changes.fanduel}`).join(' · ')
    + (s.compare ? ' · compare ' + LEAGUES.map((lg) => `${lg} DK ${s.compare[lg].draftkings?.same}/${s.compare[lg].draftkings?.diff} FD ${s.compare[lg].fanduel?.same}/${s.compare[lg].fanduel?.diff}`).join(' ') : ''));
  writeSummary();
}

function writeSummary() {
  const first = samples[0], last = samples.at(-1); if (!last) return;
  const span = (last.t - first.t) / 60000 || 1;
  const L = [];
  L.push(`# Live watch — ${etParts().year}-${etParts().month}-${etParts().day}, ${first.et}–${last.et} ET`, '');
  L.push(`Board: ${BASE} · version ${last.version} · server restarts during the window: **${restarts}** · samples: ${samples.length}`, '');
  L.push('## Price changes seen by a viewer (whole window)', '', '| League | DraftKings | FanDuel | per minute (DK / FD) |', '| --- | --- | --- | --- |');
  for (const lg of LEAGUES) L.push(`| ${lg} | ${totals[lg].draftkings} | ${totals[lg].fanduel} | ${(totals[lg].draftkings / span).toFixed(1)} / ${(totals[lg].fanduel / span).toFixed(1)} |`);
  L.push('', '## Speed (server figures at the end of the window)', '');
  const sv = last.server; const f = (x) => (x?.count ? `p50 ${x.p50} ms · p90 ${x.p90} ms · n=${x.count}` : '—');
  L.push(`* DraftKings publish → our server, live games: ${f(sv.dkPublishToServer.live)}; pregame: ${f(sv.dkPublishToServer.pregame)} (DK clock offset ${sv.dkPublishToServer.clockOffsetMs} ms, removed)`);
  L.push(`* FanDuel updatedAt → our server (push): ${f(sv.fdPushLag)}`);
  L.push(`* FanDuel: which channel delivered each price change first: ${Object.entries(sv.fdByLeague || {}).map(([lg, c]) => `${lg} push ${c.push} / poll ${c.poll}`).join(' · ') || '—'}`);
  L.push(`* FanDuel poll request: ${f(sv.fdPoll)} · markets left out of answers: ${sv.fdMarketsMissing}`);
  L.push('', '## Per 10 minutes', '', '| ET | live games | changes NFL DK/FD | college DK/FD | CFL DK/FD | server → viewer p50 | DK publish → viewer p50 | board = books (DK / FD, all leagues) | both books fresh |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of samples) {
    const live = s.compare ? LEAGUES.flatMap((lg) => s.compare[lg]?.live || []).join(', ') || '—' : '';
    const del = LEAGUES.map((lg) => s.streams[lg].serverToHere.p50).filter((x) => x != null); const e2e = LEAGUES.map((lg) => s.streams[lg].dkPublishToHere.p50).filter((x) => x != null);
    const cmp = s.compare ? ['draftkings', 'fanduel'].map((b) => { const t = LEAGUES.reduce((a, lg) => ({ same: a.same + (s.compare[lg]?.[b]?.same || 0), diff: a.diff + (s.compare[lg]?.[b]?.diff || 0), err: a.err || s.compare[lg]?.[b]?.error }), { same: 0, diff: 0, err: null }); return t.err ? `n/a (${String(t.err).slice(0, 30)})` : `${t.same}/${t.same + t.diff}`; }).join(' · ') : '';
    const c = (lg) => `${s.streams[lg].changes.draftkings}/${s.streams[lg].changes.fanduel}`;
    const fresh = Object.values(s.health.books).every((b) => !b.stale) ? 'yes' : `**no** (${Object.entries(s.health.books).filter(([, b]) => b.stale).map(([b]) => b).join(', ')})`;
    L.push(`| ${s.et} | ${live} | ${c('nfl')} | ${c('ncaaf')} | ${c('cfl')} | ${del.length ? Math.min(...del) + '–' + Math.max(...del) + ' ms' : '—'} | ${e2e.length ? e2e.join(' / ') + ' ms' : '—'} | ${cmp} | ${fresh} |`);
  }
  L.push('', 'During live play a price can change between the two reads of a comparison, so a few differences on live games are expected; pregame prices must match exactly.');
  if (siteChecks.length) { L.push('', '## The page (tools/site-check.mjs)', ''); for (const c of siteChecks) L.push(`* ${c.et}: ${c.ok ? '✔ no errors' : '✖ problems'} — ${c.summary}`); }
  fs.writeFileSync(path.join(OUT, 'summary.md'), L.join('\n') + '\n');
}

function publish() {
  if (!PUSH) return;
  try {
    execFileSync('git', ['add', OUT]); execFileSync('git', ['commit', '-q', '-m', `live watch ${etClock()} ET`], { stdio: 'ignore' });
    execFileSync('git', ['push', '-q', '-f', 'origin', 'HEAD:live-results'], { stdio: 'ignore' });
  } catch (e) { log('publish failed', e.message.split('\n')[0]); }
}

// ---------- run ----------
log(`watching ${BASE} · window ${START}–${END} ET · output ${OUT}`);
await sample(true); publish(); // a first reading straight away (proves the setup works)
{ const c = siteCheck(); siteChecks.push({ et: etClock(), ok: c.ok, summary: c.summary }); fs.writeFileSync(path.join(OUT, 'site-check-start.txt'), c.full); writeSummary(); publish(); }
while (nowEtMinutes() < etMinutes(START)) { await sleep(60_000); }
log('window open');
await sample(true).catch((e) => log('sample failed', e.message)); publish(); // the window's starting point
for (const lg of LEAGUES) listen(lg);
let n = 0, midChecked = false;
while (nowEtMinutes() < etMinutes(END)) {
  await sleep(Math.min(600_000, Math.max(30_000, (etMinutes(END) - nowEtMinutes()) * 60_000)));
  n++; await sample(true).catch((e) => log('sample failed', e.message));
  if (!midChecked && nowEtMinutes() >= etMinutes('20:45')) { midChecked = true; const c = siteCheck(); siteChecks.push({ et: etClock(), ok: c.ok, summary: c.summary }); fs.writeFileSync(path.join(OUT, 'site-check-mid.txt'), c.full); writeSummary(); }
  publish();
}
stopping = true; http.stop();
log('window closed'); writeSummary(); publish();
process.exit(0);
