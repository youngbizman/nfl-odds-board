// Latency bookkeeping. Tiny ring buffers + percentiles; exposed at /api/metrics and used for the README numbers.
export class Ring {
  constructor(n = 1000) { this.n = n; this.a = []; }
  push(v) { if (!Number.isFinite(v)) return; this.a.push(v); if (this.a.length > this.n) this.a.shift(); }
  stats() {
    if (!this.a.length) return { count: 0 };
    const s = this.a.slice().sort((x, y) => x - y);
    const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return { count: s.length, min: s[0], p50: p(0.5), p90: p(0.9), p95: p(0.95), max: s[s.length - 1], mean: Math.round(s.reduce((x, y) => x + y, 0) / s.length) };
  }
}

export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.dk = {
      // book → backend: DraftKings stamps every push with publishedTime; this is receive − published.
      ingestLagPregame: new Ring(), ingestLagLive: new Ring(),
      snapshotMs: new Ring(200), // how long one direct REST snapshot takes (warm connection)
      wsMessages: 0, selectionUpdates: 0, snapshots: 0, reconnects: 0, decodeMisses: 0, lineMovesMapped: 0, clockOffsetMs: null, clockUncertaintyMs: null,
      // edge relay (when DK is collected on another machine): round trip edge ↔ cloud over the relay WebSocket
      relayRtt: new Ring(), relayMessages: 0,
    };
    this.fd = {
      // book → backend for a poller is bounded by (interval + request time); FanDuel sends no change timestamp.
      pollDuration: new Ring(), pollInterval: new Ring(), changesPerPoll: new Ring(),
      polls: 0, pollErrors: 0, rateLimited: 0, snapshots: 0, lastStatus: null, bytes: new Ring(),
      // interleaved second poller (edge, other IP, half a beat later)
      edgePolls: 0, edgeChanges: 0, edgeStale: 0, freshInterval: new Ring(), marketsMissing: 0,
      // push (AppSync): markets received, prices they changed, and FanDuel's updatedAt → our receipt
      pushMarkets: 0, pushChanges: 0, pushLag: new Ring(),
    };
    this.sse = { clients: 0, batchesSent: 0, bytesSent: 0, batchSize: new Ring(), coalesceWait: new Ring() };
    // browser-reported: push lag (server updatedAt → browser paint) and DK end-to-end (publishedTime → browser paint)
    this.browser = { pushLag: { draftkings: new Ring(), fanduel: new Ring() }, endToEnd: { draftkings: { pregame: new Ring(), live: new Ring() } }, reports: 0 };
  }
  toJSON() {
    const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof Ring ? v.stats() : (v && typeof v === 'object' && !Array.isArray(v) ? r(v) : v)]));
    return { uptimeSec: Math.round((Date.now() - this.startedAt) / 1000), draftkings: r(this.dk), fanduel: r(this.fd), sse: r(this.sse), browser: r(this.browser) };
  }
}
