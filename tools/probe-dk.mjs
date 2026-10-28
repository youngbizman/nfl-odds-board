// Can a plain Node process (no browser) read DraftKings' snapshot and WebSocket?
import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';
import { randomUUID } from 'node:crypto';

const site = process.env.DK_SITE || 'CA-ON-SB';       // e.g. CA-ON-SB, US-NJ-SB
const siteName = process.env.DK_SITENAME || 'dkcaon'; // e.g. dkcaon, dkusnj
const wsHost = process.env.DK_WS || 'sportsbook-ws-ca-on.draftkings.com';
const H = {
  'accept': 'application/json', 'accept-language': 'en-CA', 'referer': 'https://sportsbook.draftkings.com/',
  'origin': 'https://sportsbook.draftkings.com', 'x-client-name': 'web', 'x-client-version': '2643.4.1.10',
  'x-client-page': 'league', 'x-client-feature': 'leagueSubcategory', 'x-pe-loc': 'CA-ON',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
const q = new URLSearchParams({ isBatchable: 'false', templateVars: '88808',
  eventsQuery: "$filter=leagueId eq '88808' AND clientMetadata/Subcategories/any(s: s/Id eq '4518')",
  marketsQuery: "$filter=clientMetadata/subCategoryId eq '4518' AND tags/all(t: t ne 'SportcastBetBuilder')",
  include: 'Events', entity: 'events' });
const url = `https://sportsbook-nash.draftkings.com/sites/${site}/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?${q}`;
let t = Date.now();
const r = await fetch(url, { headers: H });
const txt = await r.text();
console.log('SNAPSHOT', r.status, txt.length, 'bytes', Date.now() - t, 'ms');
if (r.status !== 200) console.log(txt.slice(0, 300));
else { const j = JSON.parse(txt); console.log(' events', j.events?.length, 'markets', j.markets?.length, 'selections', j.selections?.length); }

t = Date.now();
const ws = new WebSocket(`wss://${wsHost}/websocket?format=msgpack&locale=en`, { headers: { origin: 'https://sportsbook.draftkings.com', 'user-agent': H['user-agent'] } });
ws.on('open', () => {
  console.log('WS open', Date.now() - t, 'ms');
  ws.send(encode({ jsonrpc: '2.0', method: 'subscribe', id: randomUUID(), params: {
    entity: 'events', queryParams: {
      query: "$filter=leagueId eq '88808' AND clientMetadata/Subcategories/any(s: s/Id eq '4518') and tags/any(t: t eq 'OSB')",
      initialData: false, projection: 'sportsbook', locale: 'en',
      includeMarkets: "$filter=clientMetadata/subCategoryId eq '4518' AND tags/all(t: t ne 'SportcastBetBuilder') and tags/any(t: t eq 'OSB')" },
    forwardedHeaders: {}, clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': '2643.4.1.10' },
    jwt: 'default-token', siteName } }));
});
let n = 0;
ws.on('message', (data) => { n++; const m = decode(data); console.log('WS msg', n, JSON.stringify(m).slice(0, 300)); });
ws.on('error', (e) => console.log('WS error', String(e)));
ws.on('close', (c, r) => console.log('WS close', c, String(r)));
setTimeout(() => { console.log('done; messages:', n); process.exit(0); }, Number(process.env.SECS || 60) * 1000);
