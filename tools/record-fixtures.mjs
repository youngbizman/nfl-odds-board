// Builds the test fixtures from REAL book payloads (run from a machine both books accept).
//  - DraftKings: the snapshot + WebSocket frames recorded by tools/capture-network.mjs (research/captures/dk-nfl-long)
//  - FanDuel: a fresh snapshot + one getMarketPrices response, trimmed to three games
import fs from 'node:fs';
import { decode } from '@msgpack/msgpack';

const out = 'test/fixtures';
fs.mkdirSync(out, { recursive: true });

// ---- DraftKings ----
const dir = 'research/captures/dk-nfl-long';
const snapFile = fs.readdirSync(`${dir}/bodies`).find((f) => f.includes('sportscontent_controldata'));
const snap = JSON.parse(fs.readFileSync(`${dir}/bodies/${snapFile}`, 'utf8').split('\n\n').slice(1).join('\n\n'));
const frames = fs.readFileSync(`${dir}/ws-frames.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((f) => f.dir === 'recv' && f.b64);
const updateFrames = frames.filter((f) => { try { return decode(Buffer.from(f.b64, 'base64'))[1] === 'update'; } catch { return false; } });
// keep the event(s) the recorded deltas touch + two more
const touched = new Set(); for (const f of updateFrames) for (const m of JSON.stringify(decode(Buffer.from(f.b64, 'base64'))).matchAll(/"(341\d{5})"/g)) touched.add(m[1]);
const keepEv = new Set([...touched, ...snap.events.slice(0, 2).map((e) => e.id)]);
const markets = snap.markets.filter((m) => keepEv.has(m.eventId));
const mIds = new Set(markets.map((m) => m.id));
const dkSnap = { events: snap.events.filter((e) => keepEv.has(e.id)), markets, selections: snap.selections.filter((s) => mIds.has(s.marketId)) };
fs.writeFileSync(`${out}/dk-snapshot.json`, JSON.stringify(dkSnap, null, 1));
fs.writeFileSync(`${out}/dk-frames.json`, JSON.stringify(updateFrames.map((f) => f.b64), null, 1));
console.log('dk', dkSnap.events.length, 'events', dkSnap.selections.length, 'selections', updateFrames.length, 'frames');

// ---- FanDuel ----
const H = { accept: 'application/json', referer: 'https://sportsbook.fanduel.com/', 'user-agent': 'Mozilla/5.0', 'x-sportsbook-region': 'NJ', 'x-application': 'FhMFpcPWXMeyZxOx' };
const fd = await (await fetch('https://api.sportsbook.fanduel.com/sbapi/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York', { headers: H })).json();
const TYPES = new Set(['MONEY_LINE', 'MATCH_HANDICAP_(2-WAY)', 'TOTAL_POINTS_(OVER/UNDER)']);
const lines = Object.values(fd.attachments.markets).filter((m) => TYPES.has(m.marketType));
const evIds = [...new Set(lines.map((m) => m.eventId))].slice(0, 3);
const fdMarkets = Object.fromEntries(lines.filter((m) => evIds.includes(m.eventId)).map((m) => [m.marketId, m]));
// one unrelated market type to prove we ignore it
const extra = Object.values(fd.attachments.markets).find((m) => !TYPES.has(m.marketType) && evIds.includes(m.eventId));
if (extra) fdMarkets[extra.marketId] = extra;
const fdSnap = { attachments: { events: Object.fromEntries(evIds.map((id) => [id, fd.attachments.events[id]]).filter(([, v]) => v)), markets: fdMarkets } };
fs.writeFileSync(`${out}/fd-snapshot.json`, JSON.stringify(fdSnap, null, 1));
const ids = Object.values(fdMarkets).filter((m) => TYPES.has(m.marketType)).map((m) => m.marketId);
const prices = await (await fetch('https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ marketIds: ids }) })).json();
fs.writeFileSync(`${out}/fd-prices.json`, JSON.stringify(prices, null, 1));
console.log('fd', evIds.length, 'events', ids.length, 'markets', prices.length, 'price rows');
