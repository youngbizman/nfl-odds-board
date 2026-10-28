# How each book gets odds to the browser (what we found, Oct 28 2026, from Richmond Hill, Ontario)

Method: `tools/capture-network.mjs` drives a real Chrome (Playwright, `channel: 'chrome'`) to the public NFL page of each book,
records every HTTP request/response and every WebSocket frame for 75–240 s, and writes them to `research/captures/<book>/`.
(Bodies, HTML and raw frames are git-ignored; `summary.txt` is kept.)

## DraftKings — snapshot + WebSocket deltas (push)

| Step | What the site does |
| --- | --- |
| Page HTML | `sportsbook.draftkings.com/leagues/football/nfl` (2.8 MB, no odds in it) |
| Snapshot | `GET sportsbook-nash.draftkings.com/sites/CA-ON-SB/api/sportscontent/controldata/league/leagueSubcategory/v1/markets?templateVars=88808&eventsQuery=…subcategory 4518…&include=Events&entity=events` → JSON `{events[29], markets[87], selections[174]}` ≈ 155 KB in ~300 ms |
| Live updates | `wss://sportsbook-ws-ca-on.draftkings.com/websocket?format=msgpack&locale=en` — JSON-RPC 2.0 over MessagePack. One `subscribe` with the same OData filters, `initialData:false`, `jwt:"default-token"` (no login). Server answers `subscribed`, then pushes **only changes**. |
| Delta shape | Compact positional arrays (undocumented). A price change looks like `["0ML84695689_1","JAX Jaguars",["−500","1.20","1/5","83%","80%","1.20x"],1.2,null,34985357,["SGP","OSB"],null]` = selection id, label, display odds, true odds, points, sort order, tags, metadata. Each frame carries DK's `createdTime / receivedTime / publishedTime`. |
| Observed | 4-minute idle Wednesday afternoon: 3 delta frames (one JAX/IND moneyline move) — a quiet feed, so silence ≠ dead; we ping every 30 s. |
| Protection | Akamai. The old `sportsbook.draftkings.com/sites/US-SB/api/v5/eventgroups/88808` API → **403 Access Denied**. Headless Chromium (Playwright headless shell) → **403 on the page itself**. Real Chrome passes. Plain Node `fetch` with the browser's `x-client-*`/referer headers passes. Akamai "sensor" posts go to `sportsbook.draftkings.com/R4LIG_LUOF…` (bot-manager telemetry) — not needed for the data endpoints. |
| Geo | Region-locked by IP: from Ontario, `CA-ON-SB` answers; `US-NJ-SB`, `US-OH-SB`, `US-SB` all **403**. WS host follows the same pattern (`sportsbook-ws-us-nj.draftkings.com` exists but 403s from Ontario). → the server probes regional sites at startup. |

Ids: league `88808` = NFL, subcategory `4518` = Game Lines (moneyline/spread/total). Selection ids encode the line (`0HC84695615P350_3` = handicap +3.5), so a line move = new selection id → we re-snapshot when a delta names an unknown id.

## FanDuel — snapshot + polling (pull)

| Step | What the site does |
| --- | --- |
| Snapshot | `GET api.sportsbook.fanduel.com/sbapi/content-managed-page?page=CUSTOM&customPageId=nfl&_ak=FhMFpcPWXMeyZxOx&timezone=…` with header `x-sportsbook-region: NJ` → `attachments.{events, markets(179), …}` ≈ **1.5 MB** (includes futures/props we ignore) |
| Live updates | **No WebSocket, no SSE.** The page `POST`s `smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0` with `{marketIds:[…]}`; each widget polls its own ids **every ~5 s** (42 calls in 85 s). Response: per market `inplay`, `runnerDetails[{selectionId, handicap, winRunnerOdds.americanDisplayOdds.americanOdds, runnerStatus, previousWinRunnerOdds}]`. Market ids are stable when a spread/total moves (`bettingType: MOVING_HANDICAP`, the `handicap` field changes in place). |
| Protection | PerimeterX (`px-cloud.net` collector, `x-px-context` header on API calls). Plain Node `fetch` **without** the PX token still got 200 from a residential Ontario IP (snapshot 300 ms, prices 190 ms for 30 markets). Unknown yet from a datacenter IP — see deployment notes in the README. |
| Geo | `sbapi.on.sportsbook.fanduel.com` does not resolve; the NJ region API answered from Ontario, so the region header is a product selector more than a geo fence (for reading odds). |

Market types used: `MONEY_LINE`, `MATCH_HANDICAP_(2-WAY)` (spread), `TOTAL_POINTS_(OVER/UNDER)`. Runner `result.type` gives `HOME/AWAY/OVER/UNDER`.

## Matching the two books

Both books name teams differently ("GB Packers" vs "Green Bay Packers"). NFL nicknames are unique, so a team is resolved by its nickname
to a canonical `{abbr, city, nick}` table, and a game key is `AWAY@HOME:<US-Eastern game date>`. 29/29 games matched on the first run.

## Jurisdictions (found later, Oct 28 evening)
`sportsbook.fanduel.com` opened from Toronto calls the **NJ** API (`x-sportsbook-region: NJ`, `smp.nj.…`). FanDuel Ontario is a separate
site, `on.sportsbook.fanduel.ca`, with the same API shape on `sbapi.on.sportsbook.fanduel.ca/api/content-managed-page` and
`smp.on.sportsbook.fanduel.ca/…/getMarketPrices`, region `ON`, market ids prefixed `801.` instead of `734.`. Both answer from Toronto and from AWS Ohio.
NJ vs ON on Oct 28 19:05 ET: 174/174 prices identical. The board now uses ON to match DraftKings `CA-ON-SB`.

## Two Akamai products, two answers (Oct 28 evening)
`sportsbook-nash.draftkings.com` (REST snapshot) → 403 for datacenter IPs, every regional site. `sportsbook-ws-*.draftkings.com`
(push socket) → accepts datacenter IPs for every region (tested from Render Ohio: us-oh, us-nj, ca-on all `subscribed` in <600 ms).
The socket honours `format=json` (frames: `{add, change, remove} × {events, markets, selections}` + `data.metadata.publishedTime`).
`initialData:true` still returns changes only — the socket never hands over the board, so a snapshot from an accepted IP is required.
Consequence: hold the socket in the cloud; relay only the snapshot from the edge.
