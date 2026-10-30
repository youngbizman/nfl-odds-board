# Live watch — 2026-10-29, 18:07:00–23:02:28 ET

Board: https://nfl-odds-board-hgim.onrender.com · version 0686b06 · server restarts during the window: **0** · samples: 7

## Price changes seen by a viewer (whole window)

| League | DraftKings | FanDuel | per minute (DK / FD) |
| --- | --- | --- | --- |
| nfl | 633 | 911 | 2.1 / 3.1 |
| ncaaf | 1766 | 2367 | 6.0 / 8.0 |
| cfl | 0 | 0 | 0.0 / 0.0 |

## Speed (server figures at the end of the window)

* DraftKings publish → our server, live games: p50 40 ms · p90 133 ms · n=1000; pregame: p50 47 ms · p90 140 ms · n=291 (DK clock offset -18 ms, removed)
* FanDuel updatedAt → our server (push): p50 582 ms · p90 1022 ms · n=1000
* FanDuel: which channel delivered each price change first: ncaaf push 4763 / poll 5078 · nfl push 1296 / poll 1402
* FanDuel poll request: p50 75 ms · p90 130 ms · n=1000 · markets left out of answers: 0

## Per 10 minutes

| ET | live games | changes NFL DK/FD | college DK/FD | CFL DK/FD | server → viewer p50 | DK publish → viewer p50 | board = books (DK / FD, all leagues) | both books fresh |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 18:07:00 | — | 0/0 | 0/0 | 0/0 | — | — | 576/576 · 899/899 | yes |
| 22:10:45 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 0/0 | 0/0 | 0/0 | — | — | 564/564 · 885/885 | yes |
| 22:20:48 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 85/94 | 396/648 | 0/0 | 39.5–40.5 ms | 75.5 / 92.5 ms | 564/564 · 885/885 | yes |
| 22:32:20 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 191/236 | 421/563 | 0/0 | 46.5–47.5 ms | 105.5 / 97.5 ms | 563/563 · 881/881 | yes |
| 22:42:23 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 127/161 | 257/312 | 0/0 | 45–46 ms | 97 / 90 ms | 563/563 · 881/881 | yes |
| 22:52:26 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 111/193 | 419/467 | 0/0 | 38.5–38.5 ms | 73.5 / 81.5 ms | 563/563 · 881/881 | yes |
| 23:02:28 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 119/227 | 273/377 | 0/0 | 41.5–42.5 ms | 91.5 / 79.5 ms | 562/562 · 881/881 | yes |

During live play a price can change between the two reads of a comparison, so a few differences on live games are expected; pregame prices must match exactly.

## The page (tools/site-check.mjs)

* 18:08:33: ✔ no errors — league switch in the page          ok /  / ✔ no errors
* 22:22:18: ✔ no errors — league switch in the page          ok /  / ✔ no errors
