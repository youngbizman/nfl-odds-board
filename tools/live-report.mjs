// One-line-per-fact report of a deployed board: how each book is being read right now and how fast.
// In GitHub Actions the lines are also written as job annotations, so the run page shows them without opening logs.
// Usage: node tools/live-report.mjs https://nfl-odds-board-hgim.onrender.com
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const get = async (p) => (await fetch(`${base}${p}`, { signal: AbortSignal.timeout(20_000) })).json();
const [h, m] = await Promise.all([get('/api/health'), get('/api/metrics')]);
const dk = h.books.draftkings, fd = h.books.fanduel, s = m.sources || {};
const ms = (x) => (x == null ? '—' : `${Math.round(x)} ms`);
const lines = [
  `version ${h.version} · ${h.games} games · health ${h.ok ? 'OK' : 'NOT OK'} · edge connected: ${m.edgeConnected ? 'yes' : 'no'} · edge snapshots ignored: ${m.edgeIgnored ?? '—'}`,
  `DraftKings: ${dk.stale ? 'STALE' : 'fresh'} · ${dk.quotes} prices · snapshot via ${dk.snapshotVia} · client ${dk.transport || '—'} (native ${m.transport?.draftkings?.native ?? '—'}, browser ${m.transport?.draftkings?.browser ?? '—'}) · snapshot p50 ${ms(m.draftkings?.snapshotMs?.p50)} · book→server p50 ${ms(s.draftkings?.lagP50Ms)} over ${s.draftkings?.lagCount ?? 0} moves`,
  `FanDuel: ${fd.stale ? 'STALE' : 'fresh'} · ${fd.quotes} prices · mode ${fd.mode} · push ${fd.push || 'off'} (${m.transport?.fanduelPush?.subscribed ?? 0} markets, ${m.fanduel?.pushMarkets ?? 0} pushed, ${m.fanduel?.pushChanges ?? 0} price changes) · push lag p50 ${ms(m.fanduel?.pushLag?.p50)} p90 ${ms(m.fanduel?.pushLag?.p90)} n=${m.fanduel?.pushLag?.count ?? 0} · poll ${ms(m.fanduel?.pollDuration?.p50)} · markets missing from answers ${m.fanduel?.marketsMissing ?? '—'}`,
  `FanDuel price changes by first channel: ${Object.entries(m.fanduel?.byLeague || {}).map(([lg, c]) => `${lg} push ${c.push} / poll ${c.poll}`).join(' · ') || '—'} · pushes that only confirmed a poll: ${m.fanduel?.pushNoChange ?? '—'}`,
  ...(dk.lastError ? [`DraftKings last error: ${dk.lastError}`] : []), ...(fd.lastError ? [`FanDuel last error: ${fd.lastError}`] : []),
];
for (const l of lines) console.log(process.env.GITHUB_ACTIONS ? `::notice title=live::${l}` : l);
