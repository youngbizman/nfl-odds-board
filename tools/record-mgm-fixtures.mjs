// Records BetMGM's answers for each league through the same browser session the worker uses (test fixtures).
// Usage: node tools/record-mgm-fixtures.mjs   → test/fixtures/mgm-<league>.json (slim) + mgm-raw-sample.json (two raw fixtures)
import fs from 'node:fs';
import { BetMGMBrowser } from '../src/sources/betmgm-browser.js';
import { slimFixtures } from '../src/sources/betmgm.js';
import { LEAGUES } from '../src/leagues.js';

const out = new URL('../test/fixtures/', import.meta.url);
const s = new BetMGMBrowser({ log: (...a) => console.log(...a) });
try {
  const rawSample = { fixtures: [] };
  for (const l of Object.values(LEAGUES)) {
    const t0 = Date.now();
    const raw = await s.fetchFixtures(l.mgm, { raw: true });
    const slim = slimFixtures(raw);
    fs.writeFileSync(new URL(`mgm-${l.id}.json`, out), JSON.stringify(slim));
    const v1 = raw.fixtures.find((f) => f.games?.length), v2 = raw.fixtures.find((f) => f.optionMarkets?.length);
    for (const f of [v1, v2]) if (f && !rawSample.fixtures.some((x) => x.id === f.id)) rawSample.fixtures.push(f);
    console.log(`${l.id}: ${raw.fixtures.length} fixtures, ${s.stats.lastBytes} bytes raw → ${JSON.stringify(slim).length} slim, ${Date.now() - t0} ms`);
  }
  fs.writeFileSync(new URL('mgm-raw-sample.json', out), JSON.stringify(rawSample));
} finally { await s.close(); }
