// Checks the live board's "more lines" for one game against what each book serves right now (read from this machine).
// Usage: node tools/check-extras.mjs [boardUrl] [gameKey]
import { ExtrasStore, DK_SUBCATS, dkExtraRow, fdKind, fdExtraRef, fdOdds } from '../src/extras.js';
import { DK_HEADERS } from '../src/sources/draftkings-extras.js';
const BOARD = (process.argv[2] || 'https://nfl-odds-board-hgim.onrender.com').replace(/\/$/, '');
const board = await (await fetch(`${BOARD}/api/board`)).json();
const g = board.games.find((x) => x.key === process.argv[3]) || board.games.find((x) => x.books?.draftkings?.eventId && x.books?.fanduel?.eventId);
const ours = new Map((await (await fetch(`${BOARD}/api/extras?game=${encodeURIComponent(g.key)}`)).json()).rows.map((r) => [r.key, r]));
const truth = { draftkings: new Map(), fanduel: new Map() };
const dkEv = g.books.draftkings.eventId, fdEv = g.books.fanduel.eventId;
for (const [sub, kind] of Object.entries(DK_SUBCATS)) {
  const u = 'https://sportsbook-nash.draftkings.com/sites/CA-ON-SB/api/sportscontent/controldata/event/eventSubcategory/v1/markets?' + new URLSearchParams({ isBatchable: 'false', templateVars: `${dkEv},${sub}`, entity: 'markets',
    marketsQuery: `$filter=eventId eq '${dkEv}' AND clientMetadata/subCategoryId eq '${sub}' AND tags/all(t: t ne 'SportcastBetBuilder')` });
  const d = await (await fetch(u, { headers: DK_HEADERS })).json(); const ms = new Map((d.markets || []).map((m) => [m.id, m]));
  for (const s of d.selections || []) { const r = dkExtraRow(kind, ms.get(s.marketId), s); if (r) truth.draftkings.set(ExtrasStore.rowKey(g.key, r), r.odds); }
}
const page = await (await fetch(`https://sbapi.on.sportsbook.fanduel.ca/api/event-page?_ak=FhMFpcPWXMeyZxOx&eventId=${fdEv}&tab=popular&timezone=America%2FToronto`, { headers: { 'x-sportsbook-region': 'ON', 'user-agent': DK_HEADERS['user-agent'], accept: 'application/json' } })).json();
for (const m of Object.values(page.attachments?.markets || {})) { const kind = fdKind(m.marketType); if (!kind) continue; for (const rn of m.runners || []) { const r = fdExtraRef(kind, m, rn); const o = fdOdds(rn); if (r && o != null) truth.fanduel.set(ExtrasStore.rowKey(g.key, r), o); } }
for (const book of ['draftkings', 'fanduel']) {
  let same = 0, diff = 0, missing = 0, extra = 0; const ex = [];
  for (const [k, odds] of truth[book]) { const o = ours.get(k)?.offers?.[book]; if (!o) { missing++; continue; } if (o.odds === odds) same++; else { diff++; if (ex.length < 4) ex.push(`${k} site ${odds} board ${o.odds}`); } }
  for (const [k, r] of ours) if (r.offers[book] && !truth[book].has(k)) extra++;
  console.log(`${g.key} ${book.padEnd(10)} book serves ${truth[book].size} · identical ${same} · different ${diff} · missing on board ${missing} · on board only ${extra}`);
  for (const e of ex) console.log('    ', e);
}
const both = [...ours.values()].filter((r) => r.offers.draftkings && r.offers.fanduel).length;
console.log(`rows priced by both books: ${both}`);
