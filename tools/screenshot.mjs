// Saves a screenshot of the board (default: the live deployment) to docs/board.png
import { chromium } from 'playwright';
const url = process.argv[2] || 'https://nfl-odds-board-hgim.onrender.com/';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const p = await b.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
await p.goto(url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6000);
await p.screenshot({ path: process.argv[3] || 'docs/board.png' }); await b.close(); console.log('saved');
