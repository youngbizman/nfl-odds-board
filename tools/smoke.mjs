// Live health check for a deployed board. Exit code 0 = healthy, 1 = not.
// Checks: readiness (both books fresh, games present), SSE delivers a snapshot and a heartbeat, prices on both books.
// Usage: node tools/smoke.mjs https://nfl-odds-board-hgim.onrender.com
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const problems = [];
const t0 = Date.now();

const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(20_000) }).catch((e) => ({ error: e }));
if (r.error) { console.log(`✖ ${base} unreachable: ${r.error.message}`); process.exit(1); }
const h = await r.json().catch(() => null);
if (!h?.books) { console.log(`✖ ${base}/api/health returned ${r.status} without a health report (old version?)`); process.exit(1); }
console.log(`health ${r.status} · v${h.version} · ${h.games} games · ${h.clients} viewers`);
for (const [b, s] of Object.entries(h.books)) {
  console.log(`  ${b.padEnd(10)} ${s.stale ? 'STALE' : 'fresh'} · ${s.state} · ${s.mode} · data ${s.dataAgeMs == null ? '—' : (s.dataAgeMs / 1000).toFixed(1) + ' s'} old · ${s.quotes} prices${s.lastError ? ' · last error: ' + s.lastError : ''}`);
  if (s.stale) problems.push(`${b} is stale`);
  if (!s.quotes) problems.push(`${b} has no prices`);
}
if (!h.games) problems.push('no games on the board');

// SSE: snapshot right away, then a heartbeat within ~6 s
const ctrl = new AbortController(); const seen = { snapshot: null, batch: null };
const s = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
const dec = new TextDecoder(); let buf = '';
const deadline = Date.now() + 9000;
try {
  for await (const chunk of s.body) {
    buf += dec.decode(chunk, { stream: true });
    for (const ev of ['snapshot', 'batch']) if (!seen[ev] && buf.includes(`event: ${ev}`)) seen[ev] = Date.now() - t0;
    if ((seen.snapshot && seen.batch) || Date.now() > deadline) break;
  }
} catch {}
ctrl.abort();
console.log(`  stream     snapshot ${seen.snapshot ?? '—'} ms · first update ${seen.batch ?? '—'} ms`);
if (!seen.snapshot) problems.push('SSE sent no snapshot');
if (!seen.batch) problems.push('SSE sent no update/heartbeat within 9 s');

if (problems.length) { console.log(`✖ UNHEALTHY: ${problems.join('; ')}`); process.exit(1); }
console.log('✔ healthy');
