# @tapline/bench

Private, tool-agnostic benchmark runner. It spawns a QA tool's MCP server over stdio, exactly as an
agent does, and scores it against `docs/QUALITY-BAR.md`. Part 1 covers speed (S1-S3, S5) on the
test app's lab screen. Viewer (V) and reliability (R) suites plug in through `src/suites.ts`.

## Run

```
npm run build            # from the repo root, or inside bench/
node bench/dist/cli.js --config my-tool.json [--only speed] [--samples 20] [--runs 3] [--out bench/results]
```

Exit code: 0 when every row passes, 1 when a row fails, 2 on a runner error. The scorecard is written
to `<out>/<tool>-<link>-<ISO date without colons>.json` (`bench/results/` is git-ignored) and a table
is printed. Times are in seconds. Needs the phone connected with the lab screen in the app.

## Config

```json
{
  "tool": "tapline",
  "version": "0.1.0",
  "command": "tapline",
  "args": ["mcp"],
  "env": { "KEY": "value" },
  "phone": "iPhone 15 Pro",
  "ios": "26.5",
  "link": "good",
  "labUrl": "myapp://lab"
}
```

`env` is optional. `labUrl` is your app's deep link to its lab screen (the default, `example://lab`, is only a placeholder). `link` is `"good"` or `"3g"` and picks
the targets. It only labels the run: turn the Network Link Conditioner profile on yourself.

## Viewer suite (`--only viewer`)

Measures V1-V5 and V7 through the tool's live viewer (docs/VIEWER-PROTOCOL.md): the link comes
from the MCP tool `viewer` (the token is never printed or written), `/stream` and `/ws` are opened
with `Authorization: Bearer`. Needs the lab screen with `lab-taps` and `lab-anim-toggle`. V6 and V8
are rows with `pass: null` (they need the phone's CPU and a browser). Value rows carry `value` and
`unit`; `pass: null` means report only and never fails the run. The "picture changed" rule is one
documented function, `src/viewer/diff.ts`.

## Reliability suite (`--only reliability`, `--runs N`, default 3)

R1-R6 on the lab's fixtures, using only the shared tools (`look`, `tap`, `long_press`, `type_text`,
`toggle`, `scroll`, `wait_for`, `open_url`) plus `alert` when the tool's `listTools` has it. The whole
suite runs `--runs` times with `resetLab` before each run and at the end; one miss in any run fails
the row. Rows are `{ id, checks, misses, pass, notes }`; the notes name each missed check with the
tool's first answer line (token-redacted).

- R1 right element (state as expected), R2 no false refusals (each R1 action answered without
  `Error`), R3 `not_actionable` with the right reason and the state unchanged (disabled, covered, off
  screen, behind the sheet, under the header; behind a native alert and the share sheet only when the
  tool has `alert`, else noted as skipped), R5 `ambiguous` with `Candidates:`.
- R4 sends a person's tap through the viewer `/ws` at points from `look` (buttons, edges, overlay,
  under the bar, empty space, inside the sheet) and waits for the agent's 3 s idle after each; `busy`
  is retried once.
- R6 freezes the app's JavaScript for 20 s with the lab's `lab-freeze` button (once, after the last pass):
  the freezing tap and a look during the freeze must each end within `callLimitMs` with a success or a
  clear error (`not_answering`, `timeout`, `reconnecting`), a look after the freeze must work again
  within `afterLimitMs`, the state must read `froze=1` and the next tap must land. The times are
  options of `runReliability`: `freezeMs` (20000), `recoverMs` (2000, the wait after the freeze),
  `callLimitMs` (20000), `afterLimitMs` (5000). A lab without `lab-freeze` leaves R6 as a row with
  `pass: null` and a note.
- R7 and R8 are rows with `pass: null` (they need the app's logs and the phone's crash list, and a
  run with `link: "3g"`).

The checks are a table in `src/reliability/checks.ts`; `driver.ts` runs them, `viewerInput.ts` is R4,
`helpers.ts` has `bringIntoView`, answer parsing and the `alert` detection.
