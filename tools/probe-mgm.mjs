// One-off check: can THIS machine read BetMGM through the real worker's browser session? Exit 0 = yes.
import { BetMGMBrowser } from '../src/sources/betmgm-browser.js';
const s = new BetMGMBrowser({ log: (...a) => console.log(...a) });
let ok = true;
try {
  for (const [lg, id] of [['nfl', '35'], ['ncaaf', '103495'], ['cfl', '3845']]) {
    const d = await s.fetchFixtures(id);
    console.log(`PROBE ${lg}: ${d.fixtures.length} fixtures, ${s.stats.lastBytes} bytes, ${s.stats.lastMs} ms`);
    if (lg === 'nfl' && !d.fixtures.length) ok = false;
  }
} catch (e) { console.log(`PROBE ERROR ${e.status ?? ''} ${e.message}`); ok = false; }
finally { await s.close(); }
console.log(ok ? 'PROBE PASS' : 'PROBE FAIL');
process.exit(ok ? 0 : 1);
