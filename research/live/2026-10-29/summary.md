# Live watch — 2026-10-29, 16:26:24–21:11:41 ET

Board: https://nfl-odds-board-hgim.onrender.com · version 0686b06 · server restarts during the window: **0** · samples: 13

## Price changes seen by a viewer (whole window)

| League | DraftKings | FanDuel | per minute (DK / FD) |
| --- | --- | --- | --- |
| nfl | 860 | 1200 | 3.0 / 4.2 |
| ncaaf | 4001 | 5469 | 14.0 / 19.2 |
| cfl | 0 | 0 | 0.0 / 0.0 |

## Speed (server figures at the end of the window)

* DraftKings publish → our server, live games: p50 22 ms · p90 105 ms · n=1000; pregame: p50 47 ms · p90 140 ms · n=237 (DK clock offset -25 ms, removed)
* FanDuel updatedAt → our server (push): p50 640 ms · p90 1046 ms · n=1000
* FanDuel: which channel delivered each price change first: ncaaf push 2718 / poll 2826 · nfl push 461 / poll 662
* FanDuel poll request: p50 71 ms · p90 131 ms · n=1000 · markets left out of answers: 0

## Per 10 minutes

| ET | live games | changes NFL DK/FD | college DK/FD | CFL DK/FD | server → viewer p50 | DK publish → viewer p50 | board = books (DK / FD, all leagues) | both books fresh |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16:26:24 | — | 0/0 | 0/0 | 0/0 | — | — | 576/576 · 897/899 | yes |
| 19:20:24 | South Carolina State @ Morgan State | 0/0 | 0/0 | 0/0 | — | — | 576/576 · 899/899 | yes |
| 19:30:27 | Troy @ James Madison, South Carolina State @ Morgan State | 12/24 | 4/135 | 0/0 | 25–26 ms | 83 / 71 ms | 576/576 · 899/899 | yes |
| 19:40:29 | Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 4/6 | 327/393 | 0/0 | 22–24 ms | 153 / 68 ms | 571/576 · 899/899 | yes |
| 19:50:32 | Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 0/0 | 452/515 | 0/0 | 32.5–32.5 ms | 69.5 ms | 576/576 · 899/899 | yes |
| 20:00:35 | Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 0/0 | 528/576 | 0/0 | 24.5–24.5 ms | 45.5 ms | 575/575 · 899/899 | yes |
| 20:10:38 | Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 8/12 | 351/587 | 0/0 | 37.5–37.5 ms | 66.5 / 59.5 ms | 572/575 · 899/899 | yes |
| 20:20:40 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 99/120 | 330/507 | 0/0 | 28–30 ms | 99 / 79 ms | 564/564 · 887/887 | yes |
| 20:30:43 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 124/187 | 443/555 | 0/0 | 28.5–30.5 ms | 80.5 / 89.5 ms | 559/563 · 887/887 | yes |
| 20:40:45 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 162/227 | 408/575 | 0/0 | 29–31 ms | 72 / 86 ms | 563/563 · 887/887 | yes |
| 20:50:47 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 169/262 | 412/541 | 0/0 | 26–28 ms | 53 / 59 ms | 563/563 · 887/887 | yes |
| 21:01:38 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 139/218 | 332/470 | 0/0 | 22–25 ms | 43 / 52 ms | 563/563 · 879/887 | yes |
| 21:11:41 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 143/144 | 414/615 | 0/0 | 26.5–29.5 ms | 47.5 / 49.5 ms | 563/563 · 887/887 | yes |

During live play a price can change between the two reads of a comparison, so a few differences on live games are expected; pregame prices must match exactly.

## The page (tools/site-check.mjs)

* 16:27:14: ✔ no errors — league switch in the page          ok /  / ✔ no errors
* 20:51:36: ✔ no errors — league switch in the page          ok /  / ✔ no errors
