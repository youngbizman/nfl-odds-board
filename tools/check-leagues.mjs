// Every college / CFL game-line price on our board vs what each book's own API serves at the same moment (by the book's
// own event id, so no name matching is involved in the check). Usage: node tools/check-leagues.mjs [url]
const BOARD = (process.argv[2] || 'https://nfl-odds-board-hgim.onrender.com').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const dkH = { accept: 'application/json', referer: 'https://sportsbook.draftkings.com/', origin: 'https://sportsbook.draftkings.com', 'user-agent': UA, 'x-client-name': 'web', 'x-client-version': '2643.4.1.10' };
const fdH = { accept: 'application/json', referer: 'https://on.sportsbook.fanduel.ca/', 'user-agent': UA, 'x-sportsbook-region': 'ON', 'x-application': 'FhMFpcPWXMeyZxOx' };
const dkUrl = (id) => `https://sportsbook-nash.draftkings.com/sites/CA-ON-SB/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?${new URLSearchParams({ isBatchable: 'false', templateVars: id, include: 'Events', entity: 'events', eventsQuery: `$filter=leagueId eq '${id}' AND clientMetadata/Subcategories/any(s: s/Id eq '4518')`, marketsQuery: "$filter=clientMetadata/subCategoryId eq '4518' AND tags/all(t: t ne 'SportcastBetBuilder')" })}`;
const fdUrl = (p) => `https://sbapi.on.sportsbook.fanduel.ca/api/content-managed-page?page=CUSTOM&customPageId=${p}&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FToronto`;
const MK = { Moneyline: 'moneyline', Spread: 'spread', Total: 'total', MONEY_LINE: 'moneyline', 'MATCH_HANDICAP_(2-WAY)': 'spread', 'TOTAL_POINTS_(OVER/UNDER)': 'total' };
const num = (v) => (v == null ? null : Number(String(v).replace('−', '-').replace('+', '')));
for (const [lg, dkId, fdPage] of [['ncaaf', '87637', 'ncaaf'], ['cfl', '33567', 'cfl']]) {
  const [board, dk, fd] = await Promise.all([fetch(`${BOARD}/api/board?league=${lg}`).then((r) => r.json()), fetch(dkUrl(dkId), { headers: dkH }).then((r) => r.json()), fetch(fdUrl(fdPage), { headers: fdH }).then((r) => r.json())]);
  const q = new Map(board.quotes.map((x) => [x.id, x]));
  const byEvent = { draftkings: new Map(), fanduel: new Map() };
  for (const g of board.games) for (const b of ['draftkings', 'fanduel']) if (g.books?.[b]?.eventId) byEvent[b].set(String(g.books[b].eventId), g);
  const res = { draftkings: { same: 0, diff: 0, missing: 0, ex: [] }, fanduel: { same: 0, diff: 0, missing: 0, ex: [] } };
  const cmp = (b, g, market, side, odds, line) => {
    const r = res[b]; const x = q.get(`${g.key}|${market}|${side}|${b}`);
    if (!x) { r.missing++; if (r.ex.length < 3) r.ex.push(`missing ${g.key} ${market} ${side}`); return; }
    if (x.odds === odds && (market === 'moneyline' || x.line === line)) r.same++; else { r.diff++; if (r.ex.length < 3) r.ex.push(`${g.key} ${market} ${side}: board ${x.odds}/${x.line} book ${odds}/${line}`); }
  };
  const dkM = new Map((dk.markets || []).map((m) => [m.id, m]));
  for (const s of dk.selections || []) {
    const m = dkM.get(s.marketId); const market = MK[m?.name]; const g = m && byEvent.draftkings.get(String(m.eventId)); if (!market) continue;
    const side = market === 'total' ? (s.outcomeType || s.label).toLowerCase() : s.outcomeType?.toLowerCase();
    if (!g) { res.draftkings.missing++; continue; }
    cmp('draftkings', g, market, side, num(s.displayOdds?.american), market === 'moneyline' ? null : s.points);
  }
  for (const m of Object.values(fd.attachments?.markets || {})) {
    const market = MK[m.marketType]; if (!market) continue; const g = byEvent.fanduel.get(String(m.eventId)); if (!g) { res.fanduel.missing += m.runners?.length || 0; continue; }
    for (const r of m.runners || []) cmp('fanduel', g, market, r.result?.type?.toLowerCase(), num(r.winRunnerOdds?.americanDisplayOdds?.americanOdds), market === 'moneyline' ? null : r.handicap);
  }
  for (const b of ['draftkings', 'fanduel']) console.log(`${lg.padEnd(5)} ${b.padEnd(10)} identical ${res[b].same} · different ${res[b].diff} · not on board ${res[b].missing}${res[b].ex.length ? `  e.g. ${res[b].ex.join(' | ')}` : ''}`);
}
