// Measures what a viewer actually experiences, from outside the server, like a browser would:
//   - connects to /api/stream (SSE) and records every price change pushed
//   - push lag    = (my clock, corrected to server clock) − quote.updatedAt     → server → viewer hop, per book
//   - end-to-end  = (my clock, corrected) − quote.sourceTs                       → DraftKings' publishedTime → viewer
//   - FanDuel has no change timestamp, so its book→server hop is reported as a bound from /api/metrics (poll interval + request time)
// Usage: node tools/measure-latency.mjs <baseUrl> <minutes>
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const minutes = Number(process.argv[3] || 5);

async function clockOffset() { // NTP-style: a few round trips, keep the fastest
  let best = null;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now(); const { serverTs } = await (await fetch(`${base}/api/time`)).json(); const t1 = Date.now();
    const rtt = t1 - t0, off = serverTs - (t0 + t1) / 2;
    if (!best || rtt < best.rtt) best = { rtt, off };
  }
  return best;
}
const pct = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const stats = (arr) => arr.length ? { n: arr.length, p50: pct(arr, .5), p90: pct(arr, .9), p95: pct(arr, .95), max: Math.max(...arr) } : { n: 0 };

const { off, rtt } = await clockOffset();
console.log(`measuring ${base} for ${minutes} min · clock offset ${Math.round(off)} ms · rtt ${rtt} ms`);
const push = { draftkings: [], fanduel: [] }, e2e = { pregame: [], live: [] }, changes = { draftkings: 0, fanduel: 0 }, lineMoves = { draftkings: 0, fanduel: 0 };
let games = new Map(), batches = 0, bytes = 0;

const res = await fetch(`${base}/api/stream`, { headers: { accept: 'text/event-stream' } });
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
const stopAt = Date.now() + minutes * 60_000;
while (Date.now() < stopAt) {
  const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: null, done: false }), 1000))]);
  if (done) break; if (!value) continue;
  buf += dec.decode(value, { stream: true }); bytes += value.length;
  let i; while ((i = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    const ev = /^event: (\w+)/m.exec(chunk)?.[1]; const data = /^data: (.*)$/m.exec(chunk)?.[1];
    if (!ev || !data) continue;
    const now = Date.now() + off; const msg = JSON.parse(data);
    if (ev === 'snapshot') { games = new Map(msg.games.map((g) => [g.key, g])); continue; }
    batches++;
    for (const g of msg.games || []) games.set(g.key, g);
    for (const q of msg.quotes || []) {
      if (q.removed) continue;
      changes[q.book]++; if (q.prevLine != null && q.prevLine !== q.line) lineMoves[q.book]++;
      push[q.book]?.push(now - q.updatedAt);
      if (q.book === 'draftkings' && q.sourceTs) e2e[games.get(q.gameKey)?.status === 'live' ? 'live' : 'pregame'].push(now - q.sourceTs);
    }
  }
}
const metrics = await (await fetch(`${base}/api/metrics`)).json();
const out = { base, minutes, measuredAt: new Date().toISOString(), clockOffsetMs: Math.round(off), rttMs: rtt, batches, bytes,
  changes, lineMoves, pushLagMs: { draftkings: stats(push.draftkings), fanduel: stats(push.fanduel) },
  draftkingsEndToEndMs: { pregame: stats(e2e.pregame), live: stats(e2e.live) },
  serverSide: { draftkings: metrics.draftkings, fanduel: metrics.fanduel, sse: metrics.sse } };
console.log(JSON.stringify(out, null, 1));
const fs = await import('node:fs'); fs.mkdirSync('research/latency', { recursive: true });
const f = `research/latency/${new Date().toISOString().replace(/[:.]/g, '-')}.json`; fs.writeFileSync(f, JSON.stringify(out, null, 1)); console.log('saved', f);
