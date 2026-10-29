// Records small real "more lines" payloads from both books for one game into test/fixtures/ (run from an allowed IP).
// Usage: node tools/record-extras-fixtures.mjs <dkEventId> <fdEventId>
import fs from 'node:fs';
import { slimDk } from '../src/extras.js';
import { DK_HEADERS } from '../src/sources/draftkings-extras.js';
const [dkEv = '34118214', fdEv = '36215313'] = process.argv.slice(2);
const UA = DK_HEADERS['user-agent'];
const dkUrl = (sub) => 'https://sportsbook-nash.draftkings.com/sites/CA-ON-SB/api/sportscontent/controldata/event/eventSubcategory/v1/markets?' + new URLSearchParams({
  isBatchable: 'false', templateVars: `${dkEv},${sub}`, entity: 'markets',
  marketsQuery: `$filter=eventId eq '${dkEv}' AND clientMetadata/subCategoryId eq '${sub}' AND tags/all(t: t ne 'SportcastBetBuilder')` });
const dk = {};
for (const sub of ['13195', '12438', '16569']) {
  const d = slimDk(await (await fetch(dkUrl(sub), { headers: DK_HEADERS })).json());
  if (sub === '13195') d.selections = d.selections.filter((s) => Math.abs(s.points) <= 7.5);
  if (sub === '12438') { const keep = new Set(d.markets.filter((m) => m.marketType.name === 'Anytime Touchdown Scorer' || m.marketType.name === '1st Touchdown Scorer').map((m) => m.id)); d.markets = d.markets.filter((m) => keep.has(m.id)); d.selections = d.selections.filter((s) => keep.has(s.marketId)).filter((s, i, a) => a.findIndex((x) => x.marketId === s.marketId && x.label === s.label) === i).filter((s, i, a) => a.filter((x, j) => j < i && x.marketId === s.marketId).length < 8); }
  if (sub === '16569') { const m = d.markets.find((x) => /Josh Allen/.test(x.name)); d.markets = [m]; d.selections = d.selections.filter((s) => s.marketId === m.id); }
  d.events = [{ id: dkEv }];
  dk[sub] = d;
}
const page = await (await fetch(`https://sbapi.on.sportsbook.fanduel.ca/api/event-page?_ak=FhMFpcPWXMeyZxOx&eventId=${fdEv}&tab=popular&timezone=America%2FToronto`, { headers: { 'x-sportsbook-region': 'ON', 'user-agent': UA, accept: 'application/json' } })).json();
const keepRunner = (r) => ({ selectionId: r.selectionId, runnerName: r.runnerName, handicap: r.handicap, result: r.result, runnerStatus: r.runnerStatus, winRunnerOdds: { americanDisplayOdds: r.winRunnerOdds?.americanDisplayOdds } });
const markets = {};
for (const m of Object.values(page.attachments.markets)) {
  let runners = m.runners || [];
  if (m.marketType === 'ALTERNATE_HANDICAP') runners = runners.filter((r) => { const x = /\(([+-]?[\d.]+)\)/.exec(r.runnerName); return x && Math.abs(Number(x[1])) <= 7.5; });
  else if (m.marketType === 'ANY_TIME_TOUCHDOWN_SCORER') runners = runners.slice(0, 12);
  else if (!(m.marketType.startsWith('PLAYER_X_ALT_PASSING_YARDS') && /Josh Allen/.test(m.marketName)) && m.marketType !== 'MONEY_LINE') continue;
  markets[m.marketId] = { marketId: m.marketId, marketName: m.marketName, marketType: m.marketType, marketStatus: m.marketStatus, runners: runners.map(keepRunner) };
}
fs.writeFileSync('test/fixtures/extras-dk.json', JSON.stringify(dk));
fs.writeFileSync('test/fixtures/extras-fd.json', JSON.stringify({ attachments: { markets } }));
console.log('dk', Object.entries(dk).map(([k, v]) => `${k}:${v.markets.length}m/${v.selections.length}s`).join(' '), '· fd', Object.values(markets).map((m) => `${m.marketType}:${m.runners.length}`).join(' '));
