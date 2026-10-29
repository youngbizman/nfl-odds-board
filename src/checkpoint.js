// Durable DraftKings board, so a restart does not need DraftKings' REST snapshot (which this cloud IP cannot fetch).
//
//   dk:state   one JSON checkpoint: the DK part of the board + the id indexes needed to apply future deltas
//   dk:frames  a Redis Stream of every DK socket frame since (XADD, capped), each tagged with a sequence number
//
// Restore = load the checkpoint, replay the frames newer than it → exactly the board as of the last frame received.
// The checkpoint is rewritten every 60 s and after every snapshot, so the stream stays short.
// No REDIS_URL → no durability (everything still works; a restart just waits for a snapshot).
import { createClient } from 'redis';

export class MemoryCheckpoint { // same interface, used in tests
  constructor() { this.state = null; this.frames = []; }
  async save(state) { this.state = JSON.parse(JSON.stringify(state)); }
  async append(seq, frame, ts) { this.frames.push({ seq, frame, ts }); if (this.frames.length > 5000) this.frames.shift(); }
  async load() { return { state: this.state, frames: this.frames.slice() }; }
  async saveBlob(key, value) { (this.blobs ||= new Map()).set(key, value); }
  async loadBlob(key) { return this.blobs?.get(key) ?? null; }
  async close() {}
}

export class RedisCheckpoint {
  constructor(url, log = () => {}) { this.url = url; this.log = log; this.client = null; this.ok = false; }
  async connect() {
    this.client = createClient({ url: this.url, socket: { connectTimeout: 5000, reconnectStrategy: (n) => Math.min(n * 500, 10_000) } });
    this.client.on('error', (e) => { if (this.ok) this.log('checkpoint', `redis error: ${e.message}`); this.ok = false; });
    this.client.on('ready', () => { this.ok = true; });
    await this.client.connect(); this.ok = true;
    return this;
  }
  async save(state) { if (this.ok) await this.client.set('dk:state', JSON.stringify(state)); }
  async append(seq, frame, ts) {
    if (!this.ok) return;
    await this.client.xAdd('dk:frames', '*', { s: String(seq), t: String(ts), f: frame }, { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 5000 } });
  }
  async load() {
    const raw = await this.client.get('dk:state');
    const frames = (await this.client.xRange('dk:frames', '-', '+')).map((e) => ({ seq: Number(e.message.s), ts: Number(e.message.t), frame: e.message.f }));
    return { state: raw ? JSON.parse(raw) : null, frames };
  }
  async saveBlob(key, value) { if (this.ok) await this.client.set(key, value); }
  async loadBlob(key) { return this.ok ? this.client.get(key) : null; }
  async close() { try { await this.client?.quit(); } catch {} }
}

export async function makeCheckpoint(log) {
  if (!process.env.REDIS_URL) return null;
  try { const c = await new RedisCheckpoint(process.env.REDIS_URL, log).connect(); log('checkpoint', 'redis connected'); return c; }
  catch (e) { log('checkpoint', `redis unavailable (${e.message}); running without durability`); return null; }
}
