// DraftKings "more lines": alt spreads/totals, anytime TD, yardage and reception milestones.
// Same two channels as the main DraftKings worker, on its own socket so prop traffic never delays game lines:
//   snapshot: league-level REST per subcategory (from the edge when this IP is refused, as for the main board)
//   deltas:   the push socket, one subscription per subcategory
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { DK_SUBCATS, dkExtraRow, ExtrasStore } from '../extras.js';
import { parseAmerican } from '../model.js';
import { siteNameFor, wsHostFor } from './draftkings.js';

const BOOK = 'draftkings';
const LEAGUE = '88808';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const filters = (sub) => ({
  events: `$filter=leagueId eq '${LEAGUE}' AND clientMetadata/Subcategories/any(s: s/Id eq '${sub}')`,
  markets: `$filter=clientMetadata/subCategoryId eq '${sub}' AND tags/all(t: t ne 'SportcastBetBuilder')`,
});
export function dkExtrasUrl(nashBase, site, sub) {
  const f = filters(sub);
  const q = new URLSearchParams({ isBatchable: 'false', templateVars: `${LEAGUE},${sub}`, include: 'Events', entity: 'events', eventsQuery: f.events, marketsQuery: f.markets });
  return `${nashBase}/sites/${site}/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?${q}`;
}
export const DK_HEADERS = { accept: 'application/json', 'accept-language': 'en-CA', referer: 'https://sportsbook.draftkings.com/', origin: 'https://sportsbook.draftkings.com',
  'user-agent': UA, 'x-client-name': 'web', 'x-client-version': '2643.4.1.10', 'x-client-page': 'league', 'x-client-feature': 'leagueSubcategory' };

export class DraftKingsExtras {
  constructor(extras, board, log, opts = {}) {
    this.extras = extras; this.board = board; this.log = log;
    this.site = opts.site || process.env.DK_SITE || 'CA-ON-SB';
    this.siteName = siteNameFor(this.site); this.wsHost = wsHostFor(this.site);
    this.nashBase = opts.nashBase || process.env.DK_NASH_BASE || 'https://sportsbook-nash.draftkings.com';
    this.wsUrlOverride = opts.wsUrl || process.env.DK_WS_URL || null;
    this.subs = opts.subs || Object.keys(DK_SUBCATS);
    this.everyMs = Number(opts.everyMs || process.env.DK_EXTRAS_SNAPSHOT_MS || 120_000);
    this.marketIndex = new Map(); // DK market id -> { gameKey, kind, market }
    this.selIndex = new Map();    // DK selection id -> { gameKey, r: {kind, subject, name, line} }
    this.restBlocked = false; this.stopped = false; this.backoff = 1000; this.ws = null;
    this.counts = { frames: 0, applied: 0, unknown: 0, snapshots: 0 };
  }

  async start() {
    this.connect();
    await this.fetchAll('start');
    this.timer = setInterval(() => this.fetchAll('periodic'), this.everyMs);
  }
  stop() { this.stopped = true; clearInterval(this.timer); clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer); this.ws?.terminate(); }

  /** Snapshots straight from DraftKings when this IP is allowed (local runs); otherwise the edge sends them. */
  async fetchAll(why) {
    if (this.restBlocked || this.stopped) return;
    for (const sub of this.subs) {
      try {
        const r = await fetch(dkExtrasUrl(this.nashBase, this.site, sub), { headers: DK_HEADERS, signal: AbortSignal.timeout(20_000) });
        if (r.status === 403) { this.restBlocked = true; this.log('dk-extras', 'snapshot host refuses this IP → extras snapshots come from the edge'); return; }
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        this.applySnapshot(sub, await r.json(), Date.now(), 'direct');
      } catch (e) { this.log('dk-extras', `${why} snapshot ${sub} failed: ${e.message}`); }
      await new Promise((res) => setTimeout(res, 250));
    }
  }

  eventMap() { return new Map([...this.board.games.values()].filter((g) => g.books?.draftkings?.eventId).map((g) => [String(g.books.draftkings.eventId), g.key])); }

  /** One subcategory's full snapshot. Offers it no longer contains (for the games it covers) are dropped. */
  applySnapshot(sub, data, now = Date.now(), via = 'edge') {
    const kind = DK_SUBCATS[sub]; if (!kind || !data) return 0;
    const ev = this.eventMap(); const markets = new Map(); const games = new Set();
    for (const m of data.markets || []) { const gk = ev.get(String(m.eventId)); if (!gk) continue; const ref = { gameKey: gk, kind, market: m }; this.marketIndex.set(m.id, ref); markets.set(m.id, ref); }
    let changed = 0;
    for (const s of data.selections || []) { const ref = markets.get(s.marketId); if (!ref) continue; games.add(ref.gameKey); if (this.applySel(ref, s, now)) changed++; }
    this.extras.sweep(BOOK, kind, now, games);
    this.counts.snapshots++;
    Object.assign(this.extras.status[BOOK], { lastSnapshotAt: now, lastDataAt: now, via, detail: `${Object.keys(DK_SUBCATS).length} subcategories, push socket ${this.ws?.readyState === WebSocket.OPEN ? 'open' : 'closed'}` });
    return changed;
  }

  applySel(ref, s, now) {
    const r = dkExtraRow(ref.kind, ref.market, s); if (!r) return false;
    this.selIndex.set(s.id, { gameKey: ref.gameKey, r: { kind: r.kind, subject: r.subject, name: r.name, line: r.line } });
    return this.extras.upsert(BOOK, ref.gameKey, r, now);
  }

  wsUrl() { return this.wsUrlOverride || `wss://${this.wsHost}/websocket?format=json&locale=en`; }
  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.wsUrl(), { headers: { origin: 'https://sportsbook.draftkings.com', 'user-agent': UA }, handshakeTimeout: 15_000, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      for (const sub of this.subs) {
        const f = filters(sub);
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id: randomUUID(), params: { entity: 'events',
          queryParams: { query: `${f.events} and tags/any(t: t eq 'OSB')`, initialData: false, projection: 'sportsbook', locale: 'en', includeMarkets: `${f.markets} and tags/any(t: t eq 'OSB')` },
          forwardedHeaders: {}, clientMetadata: { feature: 'event', 'X-Client-Name': 'web', 'X-Client-Version': '2643.4.1.10' }, jwt: 'default-token', siteName: this.siteName } }));
      }
      this.log('dk-extras', `socket open, ${this.subs.length} subscriptions (${this.wsHost})`);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
    });
    ws.on('message', (buf) => this.onMessage(buf));
    ws.on('error', (e) => this.log('dk-extras', `socket error: ${e.message}`));
    ws.on('close', () => {
      clearInterval(this.pingTimer);
      if (this.stopped || this.ws !== ws) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  /** One socket frame: same shape as the main board's ({add, change, remove} × {markets, selections}). */
  onMessage(buf, now = Date.now()) {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return 0; }
    if (msg.event !== 'update') return 0;
    this.counts.frames++; this.extras.status[BOOK].lastDataAt = now;
    const d = msg.data?.data || {}; const list = (x) => (Array.isArray(x) ? x : []);
    let applied = 0;
    for (const s of list(d.remove?.selections)) {
      const id = typeof s === 'string' ? s : s?.id; const info = this.selIndex.get(id);
      if (info) { this.extras.drop(BOOK, ExtrasStore.rowKey(info.gameKey, info.r)); this.selIndex.delete(id); }
    }
    const ev = d.add?.markets?.length ? this.eventMap() : null;
    for (const m of list(d.add?.markets)) { const kind = DK_SUBCATS[m.subcategoryId ?? m.clientMetadata?.subCategoryId]; const gk = ev.get(String(m.eventId)); if (kind && gk) this.marketIndex.set(m.id, { gameKey: gk, kind, market: m }); }
    for (const s of list(d.add?.selections)) { const ref = this.marketIndex.get(s.marketId); if (ref && this.applySel(ref, s, now)) applied++; }
    for (const s of list(d.change?.selections)) {
      const info = this.selIndex.get(s.id); if (!info) { this.counts.unknown++; continue; }
      const odds = parseAmerican(s.displayOdds?.american); if (odds == null) continue;
      if (this.extras.upsert(BOOK, info.gameKey, { ...info.r, odds }, now)) applied++;
    }
    this.counts.applied += applied;
    return applied;
  }
}
