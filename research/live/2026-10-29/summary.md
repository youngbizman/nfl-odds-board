# Live watch — 2026-10-29, 16:26:24–19:30:27 ET

Board: https://nfl-odds-board-hgim.onrender.com · version 0686b06 · server restarts during the window: **0** · samples: 3

## Price changes seen by a viewer (whole window)

| League | DraftKings | FanDuel | per minute (DK / FD) |
| --- | --- | --- | --- |
| nfl | 12 | 24 | 0.1 / 0.1 |
| ncaaf | 4 | 135 | 0.0 / 0.7 |
| cfl | 0 | 0 | 0.0 / 0.0 |

## Speed (server figures at the end of the window)

* DraftKings publish → our server, live games: —; pregame: p50 47 ms · p90 140 ms · n=154 (DK clock offset 2 ms, removed)
* FanDuel updatedAt → our server (push): p50 658 ms · p90 1036 ms · n=271
* FanDuel: which channel delivered each price change first: ncaaf push 359 / poll 369 · nfl push 18 / poll 40
* FanDuel poll request: p50 90 ms · p90 131 ms · n=1000 · markets left out of answers: 0

## Per 10 minutes

| ET | live games | changes NFL DK/FD | college DK/FD | CFL DK/FD | server → viewer p50 | DK publish → viewer p50 | board = books (DK / FD, all leagues) | both books fresh |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16:26:24 | — | 0/0 | 0/0 | 0/0 | — | — | 576/576 · 897/899 | yes |
| 19:20:24 | South Carolina State @ Morgan State | 0/0 | 0/0 | 0/0 | — | — | 576/576 · 899/899 | yes |
| 19:30:27 | Troy @ James Madison, South Carolina State @ Morgan State | 12/24 | 4/135 | 0/0 | 25–26 ms | 83 / 71 ms | 576/576 · 899/899 | yes |

During live play a price can change between the two reads of a comparison, so a few differences on live games are expected; pregame prices must match exactly.

## The page (tools/site-check.mjs)

* 16:27:14: ✔ no errors — league switch in the page          ok /  / ✔ no errors
