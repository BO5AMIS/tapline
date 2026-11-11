# Changelog

## 1.1.0, "the Autopilot Update" (unreleased)

From the screen to the code: Tapline now names the file and line of your app that drew any element on
screen. Agents also get more done per call, a session becomes a test you keep, and every touch that
matters asks a person first. The interface is AGENT-TOOLS 1.8, shared with Tapwright.

**From the screen to the code**
- `inspect` (development builds): for any element on screen, it names the components that draw it, the
  file and line of your app's code that wrote it (the path is relative to the project), and that line. For
  an element a library draws, such as a tab bar button, it names your line around it and where its id is
  set.

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
