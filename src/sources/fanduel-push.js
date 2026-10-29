// FanDuel push: the price subscription FanDuel's own web app opens (AWS AppSync, GraphQL over WebSocket).
//
// Found by recording the site in a real browser (tools/capture-network.mjs): besides polling getMarketPrices, the
// app subscribes to `onUpdateMarketPrice(ids)` on pir.<region>.sportsbook.fanduel.<tld>. Each message is ONE market's
// full price picture (runners, handicaps, odds, status) the moment FanDuel changes it, stamped with FanDuel's
// `updatedAt`. It is public market data: the "key" is the web app's public client id, read from the app's own
// bundle at start-up (so a FanDuel deploy that rotates it is picked up by a reconnect, not a code change).
//
// Protocol (AppSync realtime, subprotocol "graphql-ws"):
//   connect  wss://…/graphql/realtime?header=<b64 {Authorization: clientId, host}>&payload=<b64 {}>
//   → {type:'connection_init'}            ← {type:'connection_ack', payload:{connectionTimeoutMs}}
//   → {type:'start', id, payload:{data: JSON{query, variables:{ids}}, extensions:{authorization}}}
//   ← {type:'start_ack', id}  ← {type:'data', id, payload:{data:{onUpdateMarketPrice:{…}}}}  ← {type:'ka'} keep-alives
//
// Polling stays on as the safety net: it fills anything the push missed (e.g. during a reconnect) and every
// market remembers the time of the newest answer applied, so an older answer can never overwrite a newer one.
import WebSocket from 'ws';

export const FD_PUSH_QUERY = 'subscription OnUpdateMarketPrice($ids: [String!]!) { onUpdateMarketPrice(ids: $ids) { marketId marketStatus inplay updatedAt '
  + 'runnerDetails { selectionId handicap runnerStatus winRunnerOdds { americanDisplayOdds { americanOdds } } } } }';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Where the web app (and so its push configuration) lives for a FanDuel jurisdiction. */
export function pushSiteFor(region) {
  const r = region.toLowerCase();
  return r === 'on' ? { site: 'https://sportsbook.fanduel.ca', tld: 'ca', region: r } : { site: 'https://sportsbook.fanduel.com', tld: 'com', region: r };
}

/** Read the AppSync settings out of the web app's main bundle. Throws if the shape changed (better than guessing). */
export function parsePushConfig(bundle, region = 'ON') {
  const { tld, region: r } = pushSiteFor(region);
  const anchor = `aws_appsync_graphqlEndpoint:"https://pir.{REGION}.sportsbook.fanduel.${tld}/graphql"`;
  const at = bundle.indexOf(anchor);
  if (at < 0) throw new Error('push settings not found in the FanDuel app bundle');
  const block = bundle.slice(at, at + 800);
  const get = (k) => new RegExp(`${k}:"([^"\\n]{1,200})"`).exec(block)?.[1] || null;
  const clientId = get('aws_appsync_clientId');
  const wss = get('aws_appsync_wssEndpoint');
  if (!clientId || !wss || get('aws_appsync_authenticationType') !== 'PIR_AUTH_KEY') throw new Error('FanDuel push settings changed shape');
  return { clientId, endpoint: `https://pir.${r}.sportsbook.fanduel.${tld}/graphql`, wssUrl: wss.replace('{REGION}', r) };
}

/** sw.js names the current main bundle; the bundle holds the push settings. Two small public GETs at start-up. */
export async function discoverPushConfig({ region = 'ON', fetchImpl = (...a) => fetch(...a) } = {}) {
  const { site } = pushSiteFor(region);
  const get = async (url) => { const r = await fetchImpl(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) }); if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`); return r.text(); };
  const sw = await get(`${site}/sw.js`);
  const main = /\/static\/js\/main\.[\w-]+\.js/.exec(sw)?.[0];
  if (!main) throw new Error('FanDuel app bundle not named in sw.js');
  return { ...parsePushConfig(await get(site + main), region), bundle: main };
}

export class FanDuelPush {
  constructor({ region = 'ON', onMarket, onState = () => {}, log = () => {}, getConfig, url = null, chunk = 200 } = {}) {
    this.region = region.toUpperCase(); this.site = pushSiteFor(region).site;
    this.onMarket = onMarket; this.onState = onState; this.log = log;
    this.getConfig = getConfig || (() => discoverPushConfig({ region }));
    this.urlOverride = url; this.chunk = chunk;
    this.ids = []; this.subs = new Map(); // subscription id -> { ids, acked }
    this.ws = null; this.config = null; this.stopped = true; this.backoff = 1000; this.nextSub = 1;
    this.kaTimeoutMs = 300_000; this.state = 'off';
    this.counts = { connects: 0, messages: 0, markets: 0, errors: 0, reconnects: 0 };
  }

  start() { if (!this.stopped) return; this.stopped = false; this.connect(); }
  stop() { this.stopped = true; clearTimeout(this.reconnectTimer); clearTimeout(this.watchdog); const ws = this.ws; this.ws = null; ws?.terminate(); this.setState('off'); }

  setState(state, detail = null) { if (state === this.state && !detail) return; this.state = state; this.onState({ state, detail, subscribed: this.subscribedCount() }); }
  subscribedCount() { let n = 0; for (const s of this.subs.values()) if (s.acked) n += s.ids.length; return n; }

  /** The markets to watch. Re-subscribes only when the set actually changed. */
  setMarketIds(ids) {
    const next = [...new Set(ids.map(String))].sort();
    if (next.join() === this.ids.join()) return;
    this.ids = next;
    if (this.ws?.readyState === WebSocket.OPEN && this.acked) this.subscribeAll();
  }

  async connect() {
    if (this.stopped) return;
    this.setState('connecting');
    try {
      if (!this.config) { this.config = await this.getConfig(); this.log('fd-push', `push settings read from ${this.config.bundle || 'config'}`); }
    } catch (e) { return this.retry(`settings: ${e.message}`, 30_000); }
    if (this.stopped) return;
    const auth = { Authorization: this.config.clientId, host: new URL(this.config.endpoint).host };
    this.auth = auth;
    const url = new URL(this.urlOverride || this.config.wssUrl);
    url.searchParams.set('header', Buffer.from(JSON.stringify(auth)).toString('base64'));
    url.searchParams.set('payload', Buffer.from('{}').toString('base64'));
    const ws = new WebSocket(url, ['graphql-ws'], { headers: { origin: this.site, 'user-agent': UA }, handshakeTimeout: 15_000, perMessageDeflate: false });
    this.ws = ws; this.acked = false; this.subs.clear();
    ws.on('open', () => { ws._socket?.setNoDelay(true); ws.send(JSON.stringify({ type: 'connection_init' })); this.arm(15_000); });
    ws.on('message', (buf) => { if (this.ws === ws) this.onMessage(buf); });
    ws.on('error', (e) => { if (this.ws === ws) { this.counts.errors++; this.log('fd-push', `socket error: ${e.message}`); } });
    ws.on('close', (code) => { if (this.ws !== ws) return; this.ws = null; clearTimeout(this.watchdog); if (!this.stopped) this.retry(`closed (${code})`); });
  }

  retry(why, minDelay = 0) {
    if (this.stopped) return;
    this.counts.reconnects++;
    const delay = Math.max(this.backoff, minDelay);
    this.setState('down', `${why}; retrying in ${Math.round(delay / 1000)} s`);
    if (this.counts.reconnects % 5 === 1) this.log('fd-push', `${why} → retry in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  /** Silence watchdog: AppSync promises a keep-alive within connectionTimeoutMs; no word at all → reconnect. */
  arm(ms = this.kaTimeoutMs + 10_000) {
    clearTimeout(this.watchdog);
    const ws = this.ws;
    this.watchdog = setTimeout(() => { if (this.ws === ws) { this.log('fd-push', 'no keep-alive → reconnect'); ws?.terminate(); } }, ms);
  }

  subscribeAll() {
    const ws = this.ws; if (!ws) return;
    for (const id of this.subs.keys()) ws.send(JSON.stringify({ type: 'stop', id }));
    this.subs.clear();
    for (let i = 0; i < this.ids.length; i += this.chunk) {
      const id = `p${this.nextSub++}`; const ids = this.ids.slice(i, i + this.chunk);
      this.subs.set(id, { ids, acked: false });
      ws.send(JSON.stringify({ type: 'start', id, payload: { data: JSON.stringify({ query: FD_PUSH_QUERY, variables: { ids } }), extensions: { authorization: this.auth } } }));
    }
  }

  onMessage(buf, now = Date.now()) {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    this.counts.messages++;
    this.arm();
    switch (msg.type) {
      case 'connection_ack':
        this.acked = true; this.backoff = 1000; this.counts.connects++;
        if (Number(msg.payload?.connectionTimeoutMs) > 0) this.kaTimeoutMs = Number(msg.payload.connectionTimeoutMs);
        this.arm();
        return this.subscribeAll();
      case 'start_ack': {
        const s = this.subs.get(msg.id); if (s) s.acked = true;
        if ([...this.subs.values()].every((x) => x.acked)) { this.setState('live', `${this.subscribedCount()} markets`); this.log('fd-push', `subscribed to ${this.subscribedCount()} markets`); }
        return;
      }
      case 'ka': return;
      case 'data': {
        const m = msg.payload?.data?.onUpdateMarketPrice;
        if (m?.marketId) { this.counts.markets++; this.onMarket?.(m, now); }
        return;
      }
      case 'error': case 'connection_error': {
        const text = JSON.stringify(msg.payload || msg).slice(0, 200);
        this.counts.errors++; this.log('fd-push', `${msg.type}: ${text}`);
        if (/unauthori[sz]ed|401|403|forbidden/i.test(text)) this.config = null; // re-read the public key on the next connect
        if (msg.type === 'connection_error' || !msg.id || this.subs.has(msg.id)) this.ws?.terminate();
        return;
      }
      case 'complete': if (this.subs.has(msg.id)) this.ws?.terminate(); return;
      default: return;
    }
  }
}
