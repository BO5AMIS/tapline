# Benchmarks

What Tapline measures against, how, and the latest numbers. The targets are the shared
[quality bar](QUALITY-BAR.md), the same for Tapline and Tapwright; the runner is `bench/` in this
repository, which drives a tool through MCP exactly as an agent does.

## Setup

| | |
|---|---|
| Phone | iPhone 14 Pro Max, iOS 26.5, a test phone next to the computer |
| App | a production Expo app (Expo 57, React Native 0.86, new architecture) in a development build that includes the lab screen and Tapline's native module |
| Computer | Windows 11, wired to the router; the phone on the same Wi-Fi |
| Tapline | 1.1.0 before release (main, 2026-11-12); the 1.0.0 rows below are from 2026-11-11 |
| Lab | one screen built for measuring: a state line the runner reads, buttons, inputs, a switch, a list of 40 rows, two sheets, an alert, a covered button, an animation |

The runner writes one scorecard (JSON) per run. Times are taken on the computer with one clock.

## 1.1.0, 2026-11-12

The whole bench on the same lab, Wi-Fi, after the 1.1 changes and the review fixes. Every row passes.

| | 1.1.0 | 1.0.0 (same day, same lab) | Target |
|---|---|---|---|
| Tap (S1), median / p95 | 0.23 / 0.24 s | 0.22 / 0.24 s | 0.7 / 1.2 s |
| Type, scroll, toggle (S1), median | 0.20 to 0.23 s | 0.20 to 0.22 s | 0.7 s |
| Look, text only (S2) | 0.018 s | 0.017 s | 0.5 s |
| Look with a screenshot (S3) | 0.074 s | 0.073 s | 0.8 s |
| Start to ready (S5) | 1.07 s | 1.68 s | 5 s |
| A person's tap to the picture (V1), median / p95 | 0.12 / 0.35 s | 0.12 / 0.13 s | 0.3 / 0.5 s |
| Frames a second while the screen changes (V2) | 15 | 13.6 | 15 |
| Reliability R1 to R6 | 0 misses (48, 48, 15, 21, 3, 1 checks) | 0 misses | 0 |

A tap costs about 15 ms more than in 1.0.0: before a touch, the app checks the target for the safety
policy (a dry run), inside the same turn as the touch.

**Answer size (J6).** Tokens per answer (characters ÷ 3.6; a screenshot counted by its size), over
every answer the suites above get:

| | 1.0.0 | 1.1.0 | Change |
|---|---|---|---|
| `look`, median | 453 | 419 | −7% |
| An action's answer, median | 23 | 19 | −17% |
| An action's answer, p95 | 451 | 412 | −9% |

The lab's actions mostly answer with a line or two, so the gain is smaller there than in real agent
work. Applied to 321 answers from first-time agents' runs (screens with long status lines), the same
rules bring the median action answer from 114 to 77 tokens (−32%).

**Agent use.** A first-time agent (Claude Sonnet, the tool text and the skill only) tested the lab
with the 11-point charter plus `run`, `audit` and `inspect`: 11 of 11, 51 calls, 3 state-only
reads, nothing outside the charter.

## Speed (S), 1.0.0, 2026-11-11

Twenty samples each; the median and the 95th percentile, in seconds. The full round trip: the MCP
request goes out, and the whole answer (with the change block) comes back.

| | Median | p95 | Target (median / p95) |
|---|---|---|---|
| Tap (S1) | 0.24 | 0.47 | 0.7 / 1.2 |
| Type | 0.26 | 0.70 | 0.7 / 1.2 |
| Scroll | 0.22 | 0.38 | 0.7 / 1.2 |
| Toggle | 0.22 | 0.38 | 0.7 / 1.2 |
| Look, text only (S2) | 0.019 | 0.074 | 0.5 / 1 |
| Look with a screenshot (S3) | 0.076 | 0.18 | 0.8 / 1.5 |
| Start to ready (S5) | 0.83 | | 5 |
| Back in front to the first look (S4) | 0.49 to 0.63 (five times, by hand) | | 3 |

## The live view (V), 1.0.0, 2026-11-11

The viewer page in a browser, over the same Wi-Fi, with the lab's animation running where it says so.

| | Result | Target |
|---|---|---|
| A person's tap to the picture (V1) | 0.12 s (p95 0.14) | 0.3 s (p95 0.5) |
| Frames a second while the screen changes (V2) | 15 | 15 |
| Longest gap between frames (V3) | 0.08 s | 0.25 s |
| The same while an agent looks in a loop | 0.21 s | 0.25 s |
| Sharpness, three presets (V5) | 2.05 / 1.54 / 0.77 px per point | 2.0 / 1.5 / 0.75 |
| An agent's tap while someone watches (V7) | 0.17 s | 0.7 s |
| The phone's CPU for the viewer, animation running (V6 a) | +11.9% of one core (whole phone, DVT, 65 s windows) | 30% |
| Smoothness while capturing (V6 b) | 1 slow animation frame in 4,491 | +1 point |
| The page (V8) | Chrome and Firefox: first picture under 0.3 s, click mark under 35 ms, no console errors | 1.5 s, 100 ms, none |

How 15 frames a second fit in 12% of a core: the native module draws what is on screen without
making iOS render a new frame, the app keeps at most two frames on their way, and while the screen
moves on a link that can't carry more, frames are the light preset; a still screen gets the chosen
preset back at once.

## Reliability (R), 1.0.0, 2026-11-11

Three full passes; one miss in any pass fails the row. Run twice on 2026-11-11, with the same result:
once at night, and once in the morning with the phone's notifications on (a banner can't take
Tapline's touches: they go through the app's own touch system).

| | Checks | Misses |
|---|---|---|
| The right element (R1) | 48 | 0 |
| No false refusals (R2) | 48 | 0 |
| Refuses what a person couldn't do (R3) | 15 | 0 |
| A person's tap in the viewer lands where a finger would (R4) | 21 | 0 |
| Several matches are never a guess (R5) | 3 | 0 |
| The app frozen for 20 s (R6) | 1 | 0 |

Behind an iOS alert and the share sheet (two R3 checks the runner skips for a tool that can't close
them): seen and refused, 10 of 10, checked by hand.

## Agent use (A)

An agent that has never seen Tapline (Claude Sonnet, given only what an MCP client shows, plus the
skill) tests the lab against an 11-point charter. Every call is written down whole.

| Run | Calls | Calls only to read a state | Charter | Outside it |
|---|---|---|---|---|
| Before AGENT-TOOLS v1.5, no skill | 92 | 29 | 11 of 11 | nothing |
| v1.5 | 75 | 12 | 11 of 11 | nothing |
| v1.6 | 52 | 2 | 11 of 11 | nothing |
| v1.6 with the skill | 53, then 49 | 1, then 2 | 11 of 11 | nothing |
| With Tapwright connected too | 40 (18 Tapline, 22 Tapwright) | 0 | 11 of 11 | nothing |
| 1.1 (with run, audit, inspect) | 51 | 3 | 11 of 11 | nothing |

Target: the whole charter, at most 60 calls, at most 3 state-only reads, no misread answer,
nothing outside the charter.

## Not measured

- Android, a second iPhone, an iPad, a TestFlight build.
- A computer other than this one: only Windows 11 was used. Safari (no Mac here).
- A phone away from the computer (Tailscale over another network): outside v1.
- A person judging the viewer, and a measured comparison with another tool.

## Run it yourself

```
npm install && npm run build
node bench/dist/cli.js --config my-tool.json --only speed      # or viewer, reliability
```

`bench/README.md` describes the config, the lab the runner expects, and every check.
