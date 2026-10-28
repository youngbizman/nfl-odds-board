// Records everything a sportsbook page loads: HTTP requests, JSON bodies, WebSocket frames, SSE.
// Usage: node tools/capture-network.mjs <url> <outDir> <seconds>
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [url, outDir, secondsArg] = process.argv.slice(2);
const seconds = Number(secondsArg || 60);
fs.mkdirSync(path.join(outDir, 'bodies'), { recursive: true });
const t0 = Date.now();
const log = [];
const wsFrames = fs.createWriteStream(path.join(outDir, 'ws-frames.jsonl'));
let bodyCount = 0;
const enc = (p) => (Buffer.isBuffer(p) ? { b64: p.toString('base64').slice(0, 20000) } : { text: String(p).slice(0, 8000) });
const safe = (s) => s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);

const mode = process.env.CAP_MODE || 'chrome'; // 'chrome' = real installed Chrome (visible), 'headless' = bundled headless shell
const browser = mode === 'chrome' ? await chromium.launch({ channel: 'chrome', headless: false }) : await chromium.launch({ headless: true });
console.log('browser mode:', mode);
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  locale: 'en-CA', timezoneId: 'America/Toronto', viewport: { width: 1400, height: 900 },
});
const page = await ctx.newPage();

page.on('websocket', (ws) => {
  const rec = { t: Date.now() - t0, kind: 'ws-open', url: ws.url() };
  log.push(rec); console.log('WS OPEN', ws.url());
  ws.on('framesent', (f) => wsFrames.write(JSON.stringify({ t: Date.now() - t0, dir: 'sent', url: ws.url(), len: f.payload.length, ...enc(f.payload) }) + '\n'));
  ws.on('framereceived', (f) => wsFrames.write(JSON.stringify({ t: Date.now() - t0, dir: 'recv', url: ws.url(), len: f.payload.length, ...enc(f.payload) }) + '\n'));
  ws.on('close', () => log.push({ t: Date.now() - t0, kind: 'ws-close', url: ws.url() }));
});

page.on('response', async (resp) => {
  const req = resp.request();
  const u = resp.url();
  const ct = resp.headers()['content-type'] || '';
  const rec = { t: Date.now() - t0, kind: 'http', method: req.method(), url: u, status: resp.status(), type: req.resourceType(), ct, timing: req.timing() };
  log.push(rec);
  const interesting = /json|text\/plain|event-stream/.test(ct) && !/\.(png|jpg|svg|woff|css)(\?|$)/.test(u);
  if (interesting && bodyCount < 400) {
    try {
      const buf = await resp.body();
      rec.size = buf.length;
      const name = `${String(bodyCount++).padStart(3, '0')}_${safe(new URL(u).host + new URL(u).pathname)}.txt`;
      fs.writeFileSync(path.join(outDir, 'bodies', name), `URL: ${u}\nSTATUS: ${resp.status()}\nCT: ${ct}\nREQ-HEADERS: ${JSON.stringify(req.headers())}\nPOST: ${req.postData() || ''}\n\n` + buf.toString('utf8').slice(0, 2_000_000));
      rec.bodyFile = name;
    } catch (e) { rec.bodyErr = String(e).slice(0, 100); }
  }
});

console.log('navigating', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto error', String(e)));
await page.waitForTimeout(8000);
try { fs.writeFileSync(path.join(outDir, 'page.html'), await page.content()); } catch {}
await page.screenshot({ path: path.join(outDir, 'screenshot.png'), fullPage: false }).catch(() => {});
// scroll a bit so lazy content loads, then sit and watch for updates
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 800); await page.waitForTimeout(1000); }
await page.waitForTimeout(Math.max(0, seconds * 1000 - 12000));
await page.screenshot({ path: path.join(outDir, 'screenshot-end.png') }).catch(() => {});
fs.writeFileSync(path.join(outDir, 'requests.json'), JSON.stringify(log, null, 1));
// summary: hosts + paths with counts
const counts = {};
for (const r of log) if (r.kind === 'http') { const k = `${r.method} ${new URL(r.url).host}${new URL(r.url).pathname}`; counts[k] = (counts[k] || 0) + 1; }
const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${String(v).padStart(4)}  ${k}`).join('\n');
fs.writeFileSync(path.join(outDir, 'summary.txt'), summary);
console.log(summary);
console.log('ws events:', log.filter((r) => r.kind.startsWith('ws')).length, 'bodies saved:', bodyCount);
wsFrames.end();
await browser.close();
