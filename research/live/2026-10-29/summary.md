# Live watch — 2026-10-29, 16:26:24–20:00:35 ET

Board: https://nfl-odds-board-hgim.onrender.com · version 0686b06 · server restarts during the window: **0** · samples: 6

## Price changes seen by a viewer (whole window)

| League | DraftKings | FanDuel | per minute (DK / FD) |
| --- | --- | --- | --- |
| nfl | 16 | 30 | 0.1 / 0.1 |
| ncaaf | 1311 | 1619 | 6.1 / 7.6 |
| cfl | 0 | 0 | 0.0 / 0.0 |

## Speed (server figures at the end of the window)

* DraftKings publish → our server, live games: p50 27 ms · p90 128 ms · n=1000; pregame: p50 48 ms · p90 141 ms · n=195 (DK clock offset -21 ms, removed)
* FanDuel updatedAt → our server (push): p50 623 ms · p90 1028 ms · n=792
* FanDuel: which channel delivered each price change first: ncaaf push 938 / poll 1045 · nfl push 18 / poll 44
* FanDuel poll request: p50 89 ms · p90 130 ms · n=1000 · markets left out of answers: 0

## Per 10 minutes

| ET | live games | changes NFL DK/FD | college DK/FD | CFL DK/FD | server → viewer p50 | DK publish → viewer p50 | board = books (DK / FD, all leagues) | both books fresh |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16:26:24 | — | 0/0 | 0/0 | 0/0 | — | — | 576/576 · 897/899 | yes |
| 19:20:24 | South Carolina State @ Morgan State | 0/0 | 0/0 | 0/0 | — | — | 576/576 · 899/899 | yes |
| 19:30:27 | Troy @ James Madison, South Carolina State @ Morgan State | 12/24 | 4/135 | 0/0 | 25–26 ms | 83 / 71 ms | 576/576 · 899/899 | yes |
| 19:40:29 | Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 4/6 | 327/393 | 0/0 | 22–24 ms | 153 / 68 ms | 571/576 · 899/899 | yes |
| 19:50:32 | Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 0/0 | 452/515 | 0/0 | 32.5–32.5 ms | 69.5 ms | 576/576 · 899/899 | yes |
| 20:00:35 | Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 0/0 | 528/576 | 0/0 | 24.5–24.5 ms | 45.5 ms | 575/575 · 899/899 | yes |

During live play a price can change between the two reads of a comparison, so a few differences on live games are expected; pregame prices must match exactly.

## The page (tools/site-check.mjs)

* 16:27:14: ✔ no errors — league switch in the page          ok /  / ✔ no errors
