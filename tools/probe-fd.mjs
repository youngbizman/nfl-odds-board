// Can a plain Node process read FanDuel's snapshot and price-poll endpoint without the browser's PerimeterX token?
const region = process.env.FD_REGION || 'NJ';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { accept: 'application/json', 'accept-language': 'en-CA', referer: 'https://sportsbook.fanduel.com/', origin: 'https://sportsbook.fanduel.com', 'user-agent': UA, 'x-sportsbook-region': region, 'x-application': 'FhMFpcPWXMeyZxOx' };
let t = Date.now();
const snapUrl = `https://api.sportsbook.fanduel.com/sbapi/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York`;
let r = await fetch(snapUrl, { headers: H }); let txt = await r.text();
console.log('SNAPSHOT', r.status, txt.length, 'bytes', Date.now() - t, 'ms');
if (r.status !== 200) { console.log(txt.slice(0, 300)); process.exit(1); }
const j = JSON.parse(txt);
const mk = Object.values(j.attachments.markets).filter(m => ['MONEY_LINE','MATCH_HANDICAP_(2-WAY)','TOTAL_POINTS_(OVER/UNDER)'].includes(m.marketType));
console.log(' game-line markets', mk.length, 'events', Object.keys(j.attachments.events).length);
const ids = mk.slice(0, 30).map(m => m.marketId);
t = Date.now();
r = await fetch(`https://smp.${region.toLowerCase()}.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=1`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ marketIds: ids }) });
txt = await r.text();
console.log('PRICES', r.status, txt.length, 'bytes', Date.now() - t, 'ms', 'for', ids.length, 'markets');
if (r.status !== 200) console.log(txt.slice(0, 300)); else console.log(txt.slice(0, 400));
