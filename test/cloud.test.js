// The deployment runs on its own: when the server can fetch DraftKings' snapshot itself, an edge's snapshots are
// counted and ignored, never applied over the server's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { fixture, waitFor } from './helpers.js';

const DK_SNAP = fixture('dk-snapshot.json');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

test('own DraftKings snapshots work → edge snapshots are ignored and counted', async () => {
  let restCalls = 0;
  const rest = http.createServer((req, res) => { restCalls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(DK_SNAP)); });
  await new Promise((r) => rest.listen(0, '127.0.0.1', r));
  const sock = new WebSocketServer({ port: 0 }); await new Promise((r) => sock.once('listening', r));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), SOURCES: 'draftkings', INGEST_TOKEN: 't', EXTRAS: '0', DK_HTTP: 'native', LEAGUES: 'nfl',
    DK_NASH_BASE: `http://127.0.0.1:${rest.address().port}`, DK_WS_URL: `ws://127.0.0.1:${sock.address().port}/websocket` }, stdio: 'ignore' });
  try {
    await waitFor(async () => { try { return (await (await fetch(`${base}/api/health`)).json()).books.draftkings.snapshotVia === 'direct'; } catch { return false; } }, 6000);
    const edge = new WebSocket(`ws://127.0.0.1:${port}/ingest/ws`, { headers: { authorization: 'Bearer t' } });
    await new Promise((r, j) => { edge.on('open', r); edge.on('error', j); });
    const moved = structuredClone(DK_SNAP); moved.selections[0].displayOdds.american = '+999';
    edge.send(JSON.stringify({ type: 'snapshot', why: 'test', edgeTs: Date.now(), rttMs: 10, snapshot: moved }));
    const m = await waitFor(async () => { const x = await (await fetch(`${base}/api/metrics`)).json(); return x.edgeIgnored >= 1 ? x : null; }, 3000);
    assert.equal(m.edgeIgnored, 1);
    const board = await (await fetch(`${base}/api/board`)).json();
    assert.ok(!board.quotes.some((q) => q.odds === 999), 'the edge snapshot was not applied');
    assert.equal(m.sources.draftkings.snapshotVia, 'direct');
    assert.ok(restCalls >= 1);
    edge.close();
  } finally { proc.kill(); rest.close(); sock.close(); }
});
