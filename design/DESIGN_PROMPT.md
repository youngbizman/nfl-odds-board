You are a senior product designer for trading and sports-betting tools. Design the UI for a live NFL odds comparison board, and hand it back as one working HTML file that an engineer will copy styles and markup from. I will implement your design exactly, so be precise and complete.

## What the product is
A web page that shows NFL betting odds from two sportsbooks, DraftKings and FanDuel, side by side, and highlights the best available price. Prices update live (no refresh button): a change at the book appears on screen in well under a second for DraftKings and within about 2 seconds for FanDuel.

It is a technical take-home for Betstamp, a company that builds professional odds screens for sharp bettors and traders. The people judging it are engineers and pro bettors. They care about: how fresh each number is, which book has the best price, and never being shown an old price without being told. It should feel like a fast, serious, professional tool that a trader would leave open all day, not a marketing page and not a casino. Information density matters; clarity and scannability matter more than decoration.

Do not use DraftKings, FanDuel or Betstamp logos, brand fonts or brand layouts. The book names as plain text are fine, and each book may have one identifying accent color of your choosing.

## Content and data (use this real data in the mockup)
Three markets per game: Spread, Total (over/under points), Moneyline. Each market has two sides (away/home, or over/under). Each side has a line (points, e.g. +3.5, O 47.5; moneyline has no line) and odds in American format (+160, −110). Use a real minus sign (−).

Real prices from tonight (DK = DraftKings, FD = FanDuel):

Carolina Panthers (CAR) @ Green Bay Packers (GB), Thu Oct 29, 8:15 PM ET
  spread  CAR  DK +3.5 −108 | FD +3.5 −106
  spread  GB   DK −3.5 −112 | FD −3.5 −114
  total   Over DK 47.5 −112 | FD 47.5 −102
  total   Under DK 47.5 −108 | FD 47.5 −120
  money   CAR  DK +160 | FD +160      (tie)
  money   GB   DK −192 | FD −190
Arizona Cardinals (ARI) @ Dallas Cowboys (DAL), Sun Nov 1, 1:00 PM ET
  spread  ARI  DK +7 −112   | FD +6.5 +100   (books on DIFFERENT lines)
  spread  DAL  DK −7 −108   | FD −6.5 −122   (different lines)
  total   Over DK 54.5 −108 | FD 54.5 −110
  total   Under DK 54.5 −112 | FD 54.5 −110
  money   ARI  DK +270 | FD +280
  money   DAL  DK −340 | FD −350
Atlanta Falcons (ATL) @ Tampa Bay Buccaneers (TB), Sun Nov 1, 1:00 PM ET
  spread  ATL  DK +2.5 −112 | FD +2.5 −110
  spread  TB   DK −2.5 −108 | FD −2.5 −110
  total   Over DK 44.5 −115 | FD 45.5 −105   (different lines)
  total   Under DK 44.5 −105 | FD 45.5 −115  (different lines)
  money   ATL  DK +114 | FD +118
  money   TB   DK −135 | FD −138
Baltimore Ravens (BAL) @ Buffalo Bills (BUF), Sun Nov 1, 1:00 PM ET
  spread  BAL  DK +3 −102 | FD +3 +100
  spread  BUF  DK −3 −118 | FD −3 −122
  total   Over DK 54.5 −110 | FD 54.5 −106
  total   Under DK 54.5 −110 | FD 54.5 −114
  money   BAL  DK +150 | FD +150   (tie)
  money   BUF  DK −180 | FD −178
Show ONE extra game as LIVE (in progress), e.g. Cleveland Browns (CLE) @ Pittsburgh Steelers (PIT), with Q3 8:42 and score 13–17 as sample text:
  spread  CLE  DK +3.5 −110 | FD +3.5 −115
  spread  PIT  DK −3.5 −110 | FD −3.5 −105
  total   Over DK 39.5 −108 | FD 39.5 −105
  total   Under DK 39.5 −112 | FD 39.5 −115
  money   CLE  DK +160 | FD +158
  money   PIT  DK −192 | FD −188
The real board has ~29 games across several kickoff times, so the layout must stay readable with many rows.

## Rules the design must express
1. Best price: the higher American odds wins (+280 beats +270; −106 beats −108). Show the best number big, and the book name under or beside it. Also show the other book's price small, so the comparison is visible at a glance.
2. Tie: both books have the same price. Show it as a tie, not as one book winning.
3. Different lines: on spread/total, if the two books post different numbers (DK +7 −112 vs FD +6.5 +100) they are NOT comparable. Show both offers side by side, clearly marked that the lines differ, and crown neither. This is an important, deliberate rule; make it look intentional, not like an error.
4. View toggle at the top: Best price / DraftKings only / FanDuel only. In a single-book view each number shows how long ago it last changed ("updated 12 s ago").
5. Price moved: when a price changes, the cell flashes (green when odds go up, red when they go down), shows a small up/down marker, and keeps the previous price struck through beside the new one for ~8 seconds. A line change (−3 to −3.5) is a bigger event than an odds change; make it noticeable.
6. Suspended price: the book temporarily closed betting on it. Show the number but clearly unavailable.
7. Stale book: if a book stops sending data, all its prices must be visibly marked as possibly old (greyed or similar), and a message says which book is stale and that the other is still live. The page must never quietly show old numbers.
8. Feed status for each book, always visible near the top: how it is delivered (DraftKings: "push over WebSocket"; FanDuel: "polled every 2 s"), whether it is live / stale / reconnecting, how old the latest data is ("data 3 s ago"), when a price last moved, and latency measured in the viewer's browser (DraftKings: "book to screen 180 ms"; FanDuel: "any number is at most 2.0 s old"). A freshness indicator that visibly ages between updates is welcome.
9. Recent line moves: a compact feed/ticker of the last moves (team + market, old → new, which book, how long ago). Show an empty state for when nothing has moved yet ("Lines are quiet midweek; they move constantly on Sundays and during live games").
10. Connection lost: a clear message that the page is reconnecting and prices shown are from before the drop.
11. Games grouped by kickoff time, live games first.
12. A short footer explaining the best-price rule in one or two plain sentences, and a link "How it works" (to the GitHub repo).

## Technical constraints
- Plain HTML + CSS. No frameworks, no Tailwind, no build step, no images. Fonts from Google Fonts only (pick deliberately; numbers must be tabular so columns of odds line up).
- A tiny amount of vanilla JS is allowed ONLY to (a) switch the view toggle and (b) a "Simulate a move" button that triggers the price-moved state on 2–3 cells and adds an item to the moves feed, so motion can be judged.
- Must work at 1440 px wide (main target, many games visible without scrolling sideways) and at 390 px (phone; no horizontal scrolling of the page).
- Accessible: WCAG AA contrast, visible keyboard focus, respects prefers-reduced-motion, color is never the only signal (use text/markers too).
- Light or dark theme is your call; justify it in one sentence.

## What to hand back (exactly this, in this order)
1. Design tokens: a :root block of CSS custom properties: colors (with names that say their job, e.g. --price-up), type families, a type scale, spacing scale, radii, motion durations. Then 4–6 sentences of rationale: the concept, why these colors and fonts suit a pro odds screen.
2. One self-contained HTML file (inline <style>, inline <script>) that renders the full page with the real data above and shows EVERY state at once somewhere on the page: best price, tie, different lines, price moved up, price moved down, line moved, suspended, stale book (make FanDuel stale in one demo section or via a toggle), live game, moves feed (with items) and its empty state, connection-lost banner, and the phone layout via media queries.
3. A component list: for each component (game row, price cell and each of its states, different-lines cell, feed status card, moves feed item, banners, view toggle), give the exact HTML structure and class names you used, so I can generate the same markup from code. Keep class names short and semantic.

Do not leave anything as "TBD" or placeholder. If something above conflicts, prioritize: legibility of prices > freshness/stale signals > best-price clarity > everything else.
