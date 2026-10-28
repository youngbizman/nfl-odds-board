// Many viewers at once: opens N SSE connections to the board and measures, per connection, time to the snapshot and
// the lag of every update (server stamp → received). Proves "one ingestion, N listeners" holds up.
// Usage: node tools/load-sse.mjs <baseUrl> <connections> <seconds> [viewersPerSecond]
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const N = Number(process.argv[3] || 200), SECS = Number(process.argv[4] || 60), RAMP = Number(process.argv[5] || 25); // viewers added per second
const { serverTs } = await (await fetch(`${base}/api/time`)).json(); const offset = serverTs - Date.now();
const snap = [], lag = [], hb = [], errors = []; let open = 0, batches = 0;
const ctrl = new AbortController();
const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
async function viewer(i) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
    open++; const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true }); let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        if (block.includes('event: snapshot')) snap.push(Date.now() - t0);
        else if (block.includes('event: batch')) { const m = /"serverTs":(\d+)/.exec(block); if (m) { batches++; const l = Date.now() + offset - Number(m[1]); (/"quotes":\[\{/.test(block) ? lag : hb).push(l); } }
      }
    }
  } catch (e) { if (!ctrl.signal.aborted) errors.push(String(e.message || e)); }
  finally { open--; }
}
console.log(`opening ${N} viewers against ${base} for ${SECS} s …`);
const t = Date.now();
const all = []; for (let i = 0; i < N; i++) { all.push(viewer(i)); if (i % RAMP === RAMP - 1) await new Promise((r) => setTimeout(r, 1000)); }
console.log(`all ${N} viewers opened after ${((Date.now() - t) / 1000).toFixed(0)} s; measuring steady state …`);
await new Promise((r) => setTimeout(r, SECS * 1000));
const h = await (await fetch(`${base}/healthz`)).json();
ctrl.abort(); await Promise.allSettled(all);
console.log(JSON.stringify({ viewers: N, seconds: SECS, snapshotMs: { p50: pct(snap, .5), p95: pct(snap, .95), max: Math.max(...snap, 0), n: snap.length },
  priceUpdateLagMs: { p50: pct(lag, .5), p95: pct(lag, .95), max: lag.length ? Math.max(...lag) : null, n: lag.length }, heartbeatLagMs: { p50: pct(hb, .5), p95: pct(hb, .95), max: hb.length ? Math.max(...hb) : null, n: hb.length }, batchesSeen: batches, errors: errors.length, serverSawClients: h.clients, errorSample: errors.slice(0, 2) }, null, 1));
