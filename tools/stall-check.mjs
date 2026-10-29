// Checks the page notices a silent stream (connection open, nothing arriving — what flaky HTTP/3 does) and recovers.
// Usage: start the server on :3999 (PORT=3999 node src/server.js), then: node tools/stall-check.mjs
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const pid = execSync('lsof -ti tcp:3999 -sTCP:LISTEN').toString().trim();
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage(); const errs = [];
p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.text().includes('[board]')) console.log('  page:', m.text()); });
await p.goto('http://127.0.0.1:3999/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(4000);
console.log('start: games', await p.locator('article.game').count(), 'banner hidden', await p.locator('#connection-banner').isHidden());
execSync(`kill -STOP ${pid}`); const t0 = Date.now();
await p.waitForFunction(() => !document.querySelector('#connection-banner').hidden && /reconnecting/i.test(document.querySelector('#connection-banner').textContent), null, { timeout: 30000 });
console.log(`silent stream noticed after ${((Date.now() - t0) / 1000).toFixed(1)} s:`, (await p.locator('#connection-banner').textContent()).replace(/\s+/g, ' ').slice(0, 100));
console.log('prices greyed:', await p.locator('.price.is-unavailable').count(), 'of', await p.locator('.price').count());
execSync(`kill -CONT ${pid}`); const t1 = Date.now();
await p.waitForFunction(() => document.querySelector('#connection-banner').hidden, null, { timeout: 40000 });
console.log(`recovered ${((Date.now() - t1) / 1000).toFixed(1)} s after the server answered again; games`, await p.locator('article.game').count(), 'greyed', await p.locator('.price.is-unavailable').count());
console.log('page errors', JSON.stringify(errs));
await b.close();
