// Can THIS machine hold DraftKings' push socket? Tries each regional socket host, subscribes (format=json),
// and reports: accepted?, ack time, first frames. Used from the cloud (/api/diag/dk-socket) and locally.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
export async function probeDkSocket({ region = 'us-nj', siteName = 'dkusnj', format = 'json', seconds = 8, initialData = false } = {}) {
  const url = `wss://sportsbook-ws-${region}.draftkings.com/websocket?format=${format}&locale=en`;
  const out = { url, siteName, initialData, ok: false, frames: 0, ackMs: null, sample: [], close: null, error: null, bytes: 0 };
  await new Promise((resolve) => {
    const t0 = Date.now();
    let ws; try { ws = new WebSocket(url, { headers: { origin: 'https://sportsbook.draftkings.com', 'user-agent': 'Mozilla/5.0' }, handshakeTimeout: 10_000, perMessageDeflate: false }); } catch (e) { out.error = String(e); return resolve(); }
    const done = setTimeout(() => { ws.terminate(); resolve(); }, seconds * 1000);
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id: randomUUID(), params: { entity: 'events',
      queryParams: { query: "$filter=leagueId eq '88808' AND clientMetadata/Subcategories/any(s: s/Id eq '4518') and tags/any(t: t eq 'OSB')", initialData, projection: 'sportsbook', locale: 'en',
        includeMarkets: "$filter=clientMetadata/subCategoryId eq '4518' AND tags/all(t: t ne 'SportcastBetBuilder') and tags/any(t: t eq 'OSB')" },
      forwardedHeaders: {}, clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': '2643.4.1.10' }, jwt: 'default-token', siteName } })));
    ws.on('message', (d) => { out.frames++; out.bytes += d.length; const s = d.toString(); if (out.ackMs == null && s.includes('subscribed')) { out.ackMs = Date.now() - t0; out.ok = true; } if (out.sample.length < 3) out.sample.push(s.slice(0, 600)); });
    ws.on('unexpected-response', (_, res) => { out.error = `HTTP ${res.statusCode}`; clearTimeout(done); resolve(); });
    ws.on('error', (e) => { out.error = String(e.message || e); });
    ws.on('close', (code, reason) => { out.close = `${code} ${reason}`; clearTimeout(done); resolve(); });
  });
  return out;
}
if (process.argv[1] && process.argv[1].endsWith('probe-dk-ws.mjs')) {
  for (const [region, siteName] of [['ca-on', 'dkcaon'], ['us-nj', 'dkusnj'], ['us-oh', 'dkusoh']]) {
    const r = await probeDkSocket({ region, siteName, seconds: Number(process.env.SECS || 6), initialData: process.env.INITIAL === '1', format: process.env.FORMAT || 'json' });
    console.log(`${region.padEnd(6)} ${r.ok ? 'OK  ' : 'FAIL'} ack ${r.ackMs ?? '—'} ms · frames ${r.frames} · ${r.bytes} B · ${r.error || r.close || ''}`);
    for (const s of r.sample) console.log('    ', s.replace(/\s+/g, ' ').slice(0, 400));
  }
}
