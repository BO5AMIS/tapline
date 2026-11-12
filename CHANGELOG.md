# Changelog

## 1.3.0, "the Diagnostics Update" (unreleased)

When an agent finds a bug, it now also says why. The interface is AGENT-TOOLS 1.10, shared with Tapwright.

- `logs` takes `level` (`error`, `warning` or `info`: that level and above), `grep` (lines containing a
  text) and `limit` (the newest, 1 to 500, default 100). Each entry is one line, `HH:MM:SS.mmm <level> <text>`,
  cut at 300 characters; the answer ends with `Latest:`, to pass back as `since`. `console.debug` is kept too.
- Crashes say so. A fatal JavaScript error is kept on the phone before the app dies and sent when it connects
  again. The answer of the call it ended, error answers too, says `Note: the app crashed: <the error>, at
  <file:line>. logs and crash show more.`; one that arrives later says when it happened. When the app goes away
  mid-call without a JavaScript error, the note says it may have crashed, and that Tapwright's `crash` reads
  native crash reports. A reload you asked for, the app going to the background or a normal close are no crash.
- `crash`: the newest fatal JavaScript error (`all: true`: the last 5), with its time, the top 8 frames with the
  app's own marked `*` (mapped to your files in a development build), and the component stack.
- `performance`: for `seconds` (default 3, optionally after a `tap`), the JS heap, JS frames (fps, the lowest
  second, drops over 50 ms) and the longest JS stall, and in a development build the slowest renders by
  component. `launch: true` times a JavaScript reload to the first settled screen (development builds). It
  says what it doesn't measure: CPU and the process's memory.
- In `run` and scripts, a `performance` step can carry `expect: {"under": {…}}` (`launch_s`, `js_heap_mb`,
  `fps_min`, `drops`, `busy_ms`); a limit not kept stops the batch with `expect_failed`.
- A failed `run` or `replay` step adds `Logs (since step <n>):` with up to 20 warnings and errors since that
  step began. `tapline replay --junit` puts them, and the crash note, in the test case's `<system-out>`.

## 1.2.0, "the Regression Update" (unreleased)

A script now checks how screens look, not only what they say. The interface is AGENT-TOOLS 1.9, shared with
Tapwright.

- `compare_screen` answers `Matches` or `Differs`. `threshold` is the share of the screen that may change and
  still match (default 0.5%). `ignore` paints out elements or areas that always change, such as a clock. A
  difference names its regions and the elements there, and shows a picture with the changes in red. A
  reference saved at another size is refused with both sizes.
- In `run` and scripts, a `compare_screen` step, or `expect: {"matches": name}` on a step, is a check: the
  batch stops with `expect_failed` when the screen differs.
- `record` keeps `compare_screen` calls as checks and copies their reference pictures next to the script, so
  the script and its pictures travel together. `replay` looks there first.
- `tapline replay --update-references` saves new reference pictures when a change is intended. A failed check
  saves its picture next to the script, and the JUnit report names it.

## 1.1.0, "the Autopilot Update" (2026-11-12)

From the screen to the code: Tapline now names the file and line of your app that drew any element on
screen. Agents also get more done per call, a session becomes a test you keep, and every touch that
matters asks a person first. The interface is AGENT-TOOLS 1.8, shared with Tapwright.

**From the screen to the code**
- `inspect` (development builds): for any element on screen, it names the components that draw it, the
  file and line of your app's code that wrote it (the path is relative to the project), and that line. For
  an element a library draws, such as a tab bar button, it names your line around it and where its id is
  set. Inside one of the app's own shared components (a button used on many screens) it also says
  where the screen uses it.

**Do more per call**
- `run`: several steps in one call, each an ordinary tool call with an optional `expect` (text, id or
  label appears or goes; a value; a timeout, 2 seconds by default). It stops at the first step that fails
  or whose expectation does not hold (`expect_failed`) and says which. One answer for the whole batch;
  `trace: true` lists each step.
- `dry_run: true` on every touch tool (`tap`, `long_press`, `toggle`, `type_text`, `scroll`, `back`,
  `swipe`) and on `run`: every check runs, nothing is touched. The answer says what it would do and
  whether a person's OK is needed.

**From a session to a test**
- `record` saves what the agent does as a script in the shared format (agent-tools-script, version 1);
  `replay` runs it again. Scripts keep typed text, so do not type real passwords.
- `tapline replay <name|file>… [--junit out.xml]` runs saved scripts with no agent. Exit 0 means all held,
  1 means a step stopped, 2 means it could not start.

**Find problems for the developer**
- `audit`: an accessibility check of the screen in front, run inside the app. It finds low contrast, small
  tap areas, missing labels, cut-off text, missing roles or states, overlaps and ids used twice. Each issue
  comes with its fix and, in a development build, `at <file>:<line>`. No image is needed.

**Safety**
- A touch (`tap`, `long_press`, `toggle`) on an element whose own label or text has Buy, Purchase,
  Subscribe, Pay, Delete, Remove, Send, Post, Publish, Sign out, Log out or Erase answers
  `not_allowed: needs_confirmation`. The live view asks the person (Allow once / Don't allow). One
  allow lets the same call on the same element through once, within 120 seconds.
- `tapline mcp --policy FILE` sets your own words to confirm or to block, per app. A blocked word is
  refused outright. `--no-policy` turns the policy off.
- The action log: one JSON line per action, by the agent or by a person, in `~/.tapline/log/`. Typed text
  is logged only as its length. Files are kept for 14 days. `--no-log` turns it off.
- Password fields: their value is never shown, only one • per character. Typing into one answers
  "The value is hidden (secure field)."

**Setup**
- `npx tapline-host init`, run in the app's folder, sets up the app side in one command: the entry file
  (`register` and `startTapline`; for Expo Router its own `index.js`), `metro.config.js` with
  `withTapline`, Expo Router's `app/+native-intent.ts`, `.env.local` and the three packages. Options:
  `--dry-run`, `--no-install`, `--project`. Where a file is too custom to edit, it gives exact advice. It
  warns if the production profile turns Tapline on. A second run changes nothing.
- Pairing without a QR code, in development builds: `pair` with no scheme opens an offer for 10 minutes
  (one use, local network only). A development build whose JavaScript comes from this computer's Metro
  finds it by itself and asks "Connect for testing?". The person taps Connect. TestFlight and release
  builds keep the QR code.
- `open_url` of the app's forget link now answers "Unpaired: …".

**Shorter answers**
- An action's first line no longer repeats the position and size. Change lines show position and actions
  only when they changed. A long old value is cut to what changed. Lists leave out the actions a role
  implies, such as `tap` on a button. Applied to 321 answers from real agent runs, these rules bring the
  median action answer from 114 to 77 tokens (32% less).

**Live view**
- The confirmation prompt. Every control works by keyboard, with a visible focus ring. Keys on the page's
  own controls never reach the phone. Screen readers hear each step. High contrast and reduced motion are
  supported.

## 1.0.0

First release. (2026-11-11)
