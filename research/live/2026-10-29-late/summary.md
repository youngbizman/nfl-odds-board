# Live watch — 2026-10-29, 18:07:00–23:22:34 ET

Board: https://nfl-odds-board-hgim.onrender.com · version 0686b06 · server restarts during the window: **0** · samples: 9

## Price changes seen by a viewer (whole window)

| League | DraftKings | FanDuel | per minute (DK / FD) |
| --- | --- | --- | --- |
| nfl | 982 | 1363 | 3.1 / 4.3 |
| ncaaf | 2408 | 3318 | 7.6 / 10.5 |
| cfl | 0 | 0 | 0.0 / 0.0 |

## Speed (server figures at the end of the window)

* DraftKings publish → our server, live games: p50 24 ms · p90 133 ms · n=1000; pregame: p50 47 ms · p90 140 ms · n=295 (DK clock offset -236 ms, removed)
* FanDuel updatedAt → our server (push): p50 583 ms · p90 1011 ms · n=1000
* FanDuel: which channel delivered each price change first: ncaaf push 5254 / poll 5571 · nfl push 1515 / poll 1637
* FanDuel poll request: p50 76 ms · p90 130 ms · n=1000 · markets left out of answers: 0

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
| 23:12:31 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 180/210 | 388/531 | 0/0 | 40–41 ms | 83 / 83 ms | 562/562 · 879/879 | yes |
| 23:22:34 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 169/242 | 254/420 | 0/0 | 41–42 ms | -144 / -142 ms | 551/551 · 879/879 | yes |

During live play a price can change between the two reads of a comparison, so a few differences on live games are expected; pregame prices must match exactly.

## The page (tools/site-check.mjs)

* 18:08:33: ✔ no errors — league switch in the page          ok /  / ✔ no errors
* 22:22:18: ✔ no errors — league switch in the page          ok /  / ✔ no errors
