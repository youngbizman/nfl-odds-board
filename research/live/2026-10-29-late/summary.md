# Live watch — 2026-10-29, 18:07:00–22:20:48 ET

Board: https://nfl-odds-board-hgim.onrender.com · version 0686b06 · server restarts during the window: **0** · samples: 3

## Price changes seen by a viewer (whole window)

| League | DraftKings | FanDuel | per minute (DK / FD) |
| --- | --- | --- | --- |
| nfl | 85 | 94 | 0.3 / 0.4 |
| ncaaf | 396 | 648 | 1.6 / 2.6 |
| cfl | 0 | 0 | 0.0 / 0.0 |

## Speed (server figures at the end of the window)

* DraftKings publish → our server, live games: p50 53 ms · p90 157 ms · n=1000; pregame: p50 47 ms · p90 140 ms · n=271 (DK clock offset -11 ms, removed)
* FanDuel updatedAt → our server (push): p50 607 ms · p90 1007 ms · n=1000
* FanDuel: which channel delivered each price change first: ncaaf push 4057 / poll 4321 · nfl push 928 / poll 1100
* FanDuel poll request: p50 90 ms · p90 130 ms · n=1000 · markets left out of answers: 0

## Per 10 minutes

| ET | live games | changes NFL DK/FD | college DK/FD | CFL DK/FD | server → viewer p50 | DK publish → viewer p50 | board = books (DK / FD, all leagues) | both books fresh |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 18:07:00 | — | 0/0 | 0/0 | 0/0 | — | — | 576/576 · 899/899 | yes |
| 22:10:45 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 0/0 | 0/0 | 0/0 | — | — | 564/564 · 885/885 | yes |
| 22:20:48 | CAR @ GB, Florida Atlantic @ North Texas, Troy @ James Madison, South Carolina State @ Morgan State | 85/94 | 396/648 | 0/0 | 39.5–40.5 ms | 75.5 / 92.5 ms | 564/564 · 885/885 | yes |

During live play a price can change between the two reads of a comparison, so a few differences on live games are expected; pregame prices must match exactly.

## The page (tools/site-check.mjs)

* 18:08:33: ✔ no errors — league switch in the page          ok /  / ✔ no errors
* 22:22:18: ✔ no errors — league switch in the page          ok /  / ✔ no errors
