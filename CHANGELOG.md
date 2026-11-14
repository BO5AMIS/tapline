# Changelog

## 1.8.0, "the Explorer Update" (unreleased)

Tapline can now search an app by itself and mend its own saved tests, as AGENT-TOOLS 1.15 (agreed with Tapwright, sha256
19dbc8b3) defines them. The search needs no model: an agent pays for one call, and CI can run the same thing from the
command line.

- **`explore` (§25, §27).**
  - A breadth-first search over the screens and actions nobody has driven yet. It saves new places and roads to the map and
    ends back where it started. The same build, start and map explore the same places in the same order.
  - Every move is an ordinary action with the usual checks and action log. It never touches a button that spends, sends,
    posts, deletes or signs out, a password, card or security field, a place about the account or privacy, anything in the
    policy's lists, or anything the app marked. No grant covers it, and it never answers a system alert.
  - `fill: "test-data"` types fake values only into fields the app marks as safe. A toggle it flips is flipped back, and
    a toggle it can't restore stops the run.
  - The report is `report.md` and `report.json` in `~/.tapline/explore/<app id>/<time>/` (the newest 20 are kept), with
    coverage, what was skipped and why, and the findings. A finding is one shape: crash, JS error, dead end, refused touch,
    slow screen, accessibility or UX problem, or a place that couldn't be reached. Each has its path, a small picture where
    it helps and a script that repeats it. Nothing typed or secret is written; a vault value never appears.
  - `tapline explore [--minutes N] [--steps N] [--depth N] [--from PLACE] [--focus PLACE] [--fill test-data] [--continue]
    [--account NAME]`: exit 0 nothing found, 1 findings, 2 couldn't start or was stopped. The MCP tool sends a progress
    note every 10 steps.
- **Self-repairing tests (§26).**
  - `replay` with `repair: "suggest"` (or `tapline replay <name> --repair suggest`) says how a step that no longer finds its
    target would be mended, and touches nothing. `apply` makes the repair, runs on, and writes `<name>.repaired.json` and
    `<name>.repair.md` next to the script; the original stays as it is. Every repair is written to the audit log.
  - A repair is made only for a renamed or moved target, a screen in the way, or an element behind a scroll, with at most 3
    candidates tried and 5 repairs per run. A near tie is not repaired.
  - `tapline replay <name> --repair apply --adopt` replaces the original with the repaired file after a repaired run passed,
    and keeps the first original as `<name>.orig.json`. It is a person's choice: the tool call has no `adopt`.
  - Never repaired: a failed `expect`, which is reported as a finding, typed text, a sign-in, a one-time code, a toggle of
    another kind, a native Back, a step under a policy word, and any tool other than a touch or a scroll.
- **The explored record and coverage (§28).** The map keeps what the explorer did at each place (tried, refused, skipped, what
  is left), merged by action signature, with no row text and no typed text. `map` gains a `Coverage:` line.
- **SDK props.** `taplineExploreSkip` keeps the explorer from a view and everything inside it; `taplineExploreFill` marks an
  input it may type into (`true`, `"vault:<entry>.<field>"` or `"fixture:<name>"`). Both are in the tree sent to the host,
  inherited down the tree, and typed as `TaplineExploreProps`. The id suffix `-test-safe` marks an input as well.
- **Known limits.**
  - Repair scores only the id stem and the words, because a saved script keeps only the target (no role, position or
    component of the old element), so a rename like `Skip` to `Not now` is not repaired.
  - A `fixture:<name>` mark is read but not typed yet.
  - `explore` can't be scheduled, and it does not answer a system alert or reopen the app after a crash: a person does.
  - Nothing here has run on a real phone yet; the tests use a fake app and a fake host.
  - The host reads its own version from its package.json, so findings and reports carry it.

## 1.7.0, "the Control Update" (2026-11-14)

Standing permissions, personal data by name, safety for text written by strangers, scheduled runs, and a record of
all of it, as AGENT-TOOLS 1.14.2 (agreed with Tapwright, sha256 3faca1e4) defines them. Tapline works inside the user's own
app; the whole phone (system apps, notifications, unattended running) is Tapwright's.

- **Grants (§19).**
  - A grant is a person's standing OK for a kind of touch in one app, with limits. It lives in a version 2 policy file
    (`--policy FILE`).
  - A grant names its words, and optionally a route, counts per day and per hour, an end at most 30 days away, quiet
    hours, and drafts only.
  - A covered touch goes through with `Note: allowed by grant "…" (2 of 3 today).`
  - Each use claims its own slot file next to the policy file (`<policy>.uses/`), with an exclusive create, so two
    tools sharing the file share the counts and no stalled process can count a use twice.
  - Some touches can never be granted: payments, account deletion, cards, and the block list.
  - After a person's "Allow once" in the chat dialog, the host may offer a grant. Only the person's answer creates it.
  - The live view's Pause stops every grant, and `tapline grants --revoke-all` revokes them all.
  - Every change to the policy file is made under an edit lock that no one can take from a living holder. The file is
    read again under the lock, so a grant created during a revoke can't undo it.
  - `tapline grants` lists the grants, and session reports gain a `Grants:` line.
- **The vault (§20).**
  - The test-accounts file grows into a vault: accounts, cards, addresses, identities and notes, typed by name with
    `${vault.<name>.<field>}`. `${account.…}` still works.
  - The file can be protected: with DPAPI on Windows or the keychain on macOS (`tapline vault protect FILE`), in the
    format Tapwright reads too.
  - No value appears in any answer, log, map, script, route, report or dialog, in any encoding.
  - A card is typed only with a person's OK every time.
- **One-time codes.** `${otp.<app>}` types a sign-in code that Tapwright 1.7 read from a notification. The code is never
  shown. Tapwright's daemon must prove itself on the same loopback connection before Tapline sends it the token.
- **Content from others (§21).**
  - The app can wrap views that hold other people's text in `<TaplineFromOthers>`, and answers then mark it
    `text (from others) "…"`.
  - The skill and the server instructions say to treat all text the agent didn't write as data, never as instructions.
  - **Drafts only:** Send, Post, Publish, Reply and Comment under a drafts-only grant or route stop before the touch.
    The draft is shown to a person to send or not.
- **Scheduled runs (§22).**
  - `tapline schedule add|list|remove` writes a schedule and registers a Windows task. A time schedule wakes the PC; a
    file trigger's once-a-minute check does not.
  - `tapline run-schedule` runs the route with grants, the vault and drafts only in force. It skips, with the exact
    reason, when the phone is in use, the app isn't open, or a run is still going.
  - A run reuses a running `tapline host` only when that host's policy, accounts and maps match the schedule's, by
    content. It stays pinned to that host instance, and holds the phone with a lease that other agents can't spoof.
  - Locks are published whole and taken over only from a holder proven dead. `tapline doctor` names a stuck lock, and
    `tapline schedule unlock <name>` and `tapline grants unlock` remove one when no living holder is proven.
- **The audit log (§23).** Grant uses, revocations, approvals, vault and code uses, and scheduled runs are recorded in
  `~/.tapline/audit/`, and kept 90 days. Read them with `tapline audit-log`.
- **Security fix for `tapline call` (in every release since 1.6.0).**
  - Before, the thin call proved the host on one connection, then sent its token on a second connection. A program that
    took over the host's port between the two could receive the token.
  - The proof, its check and the call now share one connection, and nothing is sent if it closes after the proof.
  - The host side was already right, so updating only the command line closes it. If you used `tapline call` on a computer
    where other people's programs run, consider a new token (delete `~/.tapline/token`; phones then pair again).
- **Also from AGENT-TOOLS 1.13.3:**
  - An alert's message shows in the `Alert:` line (`Alert: "<title>" "<message>" [Button] …`). It is redacted and cut
    like element text, and never matched against policy words.
  - `drive` takes `look`: `look: false` answers with the first line only and wins over `brief`. A stop always carries
    the screen.

## 1.6.2 (2026-11-14)

Fixes found on the phone after 1.6.1 (Wayfare on a real iPhone, iOS 26.5). No change to the shared documents.

- `drive` by link works more than once to a place the app lists up front. The first visit saved the place without its
  link, so the next `drive {"to": "notes", "by": "link"}` answered "notes has no link to jump to". A visited place now
  uses the link the app declares for it. A declared link that needs params is used only when `with` gives them all, none
  empty.
- A development build paired with a host that has stopped (or moved to another port) takes a new zero-QR offer from the
  computer serving its code. Before, it kept retrying the old host and ignored the offer until the forget link was
  opened. The person is still asked "Connect for testing?" first.
  - If the old host comes back while the question is open, it is kept.
  - If the offered computer doesn't answer within 15 s, the app goes back to the saved one. The saved pairing changes
    only when the new one succeeds.
- A target outside every scroll view (a button under a fixed bar, or under the bars iOS draws) is no longer told to
  scroll: the refusal says it can't be scrolled clear.

## 1.6.1 (2026-11-13)

Shared documents brought up to date with Tapwright, and small CI hardening. No change to how Tapline drives an app.

- QUALITY-BAR 2.5 (shared with Tapwright): R3's off-screen case is now one no scroll can reach (`lab-behind-bar`, a
  button the lab's fixed header covers), and `lab-bottom` moves to R1, where the tool scrolls to it and taps. The
  bench follows it, and proves the scroll: `lab-bottom` must be off screen before the tap and on screen right after
  it, so a tool that fires the handler without scrolling fails R1.
- AGENT-TOOLS 1.13.2 (shared with Tapwright): pictures are free of a password only while its field stays secure; the
  live view hears `confirm_closed` with `"by": "chat"` when the chat dialog answers first; the passcode unlock is
  marked planned; Tapwright no longer names places after titles. Tapline already behaves this way.
- The macOS job that compiles the native module keeps no git credential and stops after 30 minutes.

## 1.6.0, "the Speed Update" (2026-11-13)

The same checks in fewer calls and fewer seconds, on ground the agent has been over before. The interface
is AGENT-TOOLS 1.13 plus the 1.13.1 clarifications, shared with Tapwright. Tapline never navigates from
inside the app: a drive is the app's own taps, or a deep link.

- Fix: apps on Expo SDK 55 (iOS 15.1) now get the native module. Its podspec asked for iOS 16.4, and CocoaPods
  silently skips a pod that needs a newer iOS than the app. A new macOS CI job builds a blank Expo app with the SDK
  (the newest Expo and SDK 55), so the native code is compiled on every change.
- `drive`: go to a place in one call, `drive {"to": "language"}`, or run a saved route. It follows the
  roads the map knows, checks every move like a single call (the policy, a person's OK) and always checks
  the arrival. A stale road is repaired by another name or planned again; otherwise `off_route`, with
  nothing more touched. `by` picks taps only or a link only, `with` fills a link's params or a route's
  variables, `then` goes on with `run` steps, and `dry_run` says the way. It works as a `run` step too.
- `map`: the app's places, roads, links, routes and reflexes, learned as you work, kept in
  `~/.tapline/maps/<app id>/` (`--maps DIR` moves them). `to` shows the way, `name`, `link`, `reflex`,
  `forget_reflex` and `forget` edit it. A place is a route pattern, never a param, never screen text; a
  list row, typed text and secure values are never saved. A road is `proven` for the build it ran on.
- The `Place:` line: where the app is, after the first line of an answer, once the app has a saved
  place. `GET /place?app=` answers the same from memory (loopback, bearer token).
- Routes: `record` with `route` saves a flow from one place to another as a script (version 2) with
  variables (`type_text` takes `as`), and `drive {route}` runs it. Old scripts replay as before.
- Reflexes: a rule in the map, `map {reflex}`, that closes a known interruption ("Not now" on a rate
  prompt) when it shows up at a place change or before a failure answer, and says so in a `Reflex:` line.
  Only reflexes declared in the map run. A reflex never takes a touch that needs a person's OK, never
  runs during a replay or on a permission prompt, and is off in a user's-eyes journey unless `allow` names
  `reflexes`.
- Loading means wait: a target that is missing while a spinner shows or a request is running is waited
  for, a little, before `not_found`.
- `brief`: an action answers in at most 12 element lines, with the screen's new text first, and
  `…<n> more: look shows them.` `--brief` makes it the default; `brief: false` on a call overrides it.
- `if` and `optional` on a `run` step: a step that runs only when something is on screen
  (`{"if": {"text": "Rate this app"}}`), or only when its target is (`optional: true`). A skipped step
  counts as passed and is said.
- Test accounts: `--accounts FILE`, JSON with usernames and passwords by name. `type_text`, `run` and
  `drive` take `account`, and the host types the value, so the agent never sees it: every answer, log,
  report and recording shows `<tester2's password>`. A password goes only into a password field. The file
  is refused inside a git work tree that doesn't ignore it. Needs the new `typeKind` capability in the app.
- A person's OK in the chat: a touch that needs one opens the host's own dialog (Allow once / Don't allow)
  where the MCP client can show one, and the live view asks too; the first answer wins, and the call waits
  up to 120 s. `--no-dialog` keeps it to the live view. Records say where the OK came from.
- "Needs a person" moments: when the app isn't open, was backgrounded, shows an alert Tapline can't tap, or
  froze, the same dialog says what to do (`Needs a person: open Wayfare on the phone ...`), and the call goes
  on by itself when it clears.
- The clearer no-change note: a tap or long press that changes nothing is watched for 0.5 s, then says
  `Note: the tap was delivered, and nothing on screen changed within 0.5 s.` with why when it knows (the
  handler threw, only a parent handled it, a request is still running).
- `off_screen` no longer tells you to scroll: it means nothing scrolls there.
- `compare_screen` under the threshold names what changed (`Matches the reference "x" (0.33% changed ...):
  changed at e9 text "..."`); a name that differs only in case from an existing one is refused.
- `session_report` has a `Time:` line (thinking between calls, time in the tool, by tool), `Accounts:` and
  `Approvals:`, and flags calls each from a new process and three or more taps on a way the map knows (one
  `drive`).
- `tapline call <tool> '<json>'`: one tool call to a running `tapline host`, about 0.1 s a call, for an
  agent that has no MCP server loaded. `tapline host` is now a full host with the live view and takes the
  options of `mcp`. `POST /api/<tool>` is its wire; a host inside an agent's MCP server doesn't serve it.
- `journey`: `drive` uses roads of taps only, and its `allow` can name `drive`, `reflexes` and
  `fast_animations`.
- Faster settling, behind a flag: the app can answer an action as soon as the animations, interactions and
  requests it can see are idle, a frame or two later, instead of after 100 ms of quiet. The app's
  `knowIdle` option turns it on and **it is off** until the device gate. Reanimated, sheets and modals keep
  the 100 ms window.
- Fast animations, opt-in: `app_command animations {speed: "fast"}` scales `Animated`, `LayoutAnimation`
  and the native window layers to 2 percent and asks Reanimated for reduced motion, so a transition ends in
  about a tenth of a second. It is never on by default, every answer says `Animations: fast (Tapline).`,
  `performance`, `filmstrip` and `compare_screen` run at normal speed, a user's-eyes journey refuses it, and
  it goes back to normal when the session ends. **The native layer needs a new native build** of the app
  (react-native-tapline's native module); without it the JavaScript layers still work.
- New app capabilities (an older app keeps working without them): `place`, `places`, `move`, `waitOnce`,
  `pressFacts`, `typeKind`, `idle`, `animations`. The app's id is its own, also in Expo Go, and its build is
  `<version> (<build number>)`.

## 1.5.0, "the Real User Update" (2026-11-12)

Tests whether people can find, understand and finish a feature, not only whether it works. The interface
is AGENT-TOOLS 1.12, shared with Tapwright.

- `journey`: `start` with a goal and a persona, then act in a user's eyes: only what shows on the glass,
  no ids or labels, nothing scrolls by itself, and shortcuts (`open_url`, `app_command`) only when the
  start allows them. `stop` gives the taps to the goal, the time, wrong turns, hesitations and dead ends,
  and the findings by severity.
- A report folder per journey in `~/.tapline/journeys`: report.md, report.html, a GIF of the run with
  the taps marked, and a picture per finding. The newest 20 are kept. Typed text never goes in.
- `export` on `stop` puts the report on a pull request or an issue through the user's own `gh`, only
  with `confirm: true`, and refuses a public repository unless `public: true`.
- Stress moments: a bad network and a double tap at once; background, rotate and a relaunch with a
  person, counted only when the app shows they happened. `survives` checks what must still be there.
- `ux_check`: the screen against usability basics, and house rules with `--ux-rules FILE`.
- `media`: test pictures for an app's photo picker, in the phone's library or straight to the next
  image-picker call, with the user's `confirm`; `remove` deletes only what this phone's session added.
- Personas: a recipe and examples in the skill (`references/personas.md`).
- The app needs none of the photo modules: `media` uses them when they are there, and an app without
  them bundles and runs as before.

## 1.4.0, "the Fewer Steps Update" (2026-11-12)

The same check now takes fewer calls. A tester's iPhone runs needed about 1.5 times the calls of
Android; this release goes after where they went. The interface is AGENT-TOOLS 1.11, shared with Tapwright.

- An action (`tap`, `long_press`, `toggle`, `type_text`) on an element that is in the list but off
  screen scrolls it into view and acts, in one call: `Scrolled to it, then tapped e41 button "Save"
  id=save.` The safety check runs on the target before the scroll; `dry_run` says where it would tap.
- `not_found` names up to 3 close matches with their refs (`Closest: e12 button "Save draft"
  id=save-draft, e30 text "Saved" (off screen, below).`): another case or word order, one inside the
  other, or a small typo.
- Every call is logged, reads too, with the agent's name and the answer's size (never typed text,
  pictures or log text). `session_report` and `tapline report` count the calls per tool and the
  failures, and flag the waste: a look right after an answer that already had the changes, a retry
  after `not_found`, scroll hunts, and actions that could have been one `run`.
- `app_command network`: `offline`, `3g`, `lossy` or `normal` for the app's own requests. Every
  answer says the condition while it is on, and it goes back to normal by itself when the session ends.
  Tapline's own connection is never slowed.
- Language, region and text size without the phone's Settings: the standard `app_command` names
  `language`, `region` and `text_size`, with the values both tools share. The SDK checks the values,
  `useTaplineFontScale()` lets an app follow `text_size` (the value holds the system scale, so that text
  sets `allowFontScaling={false}`), a switch to or from a right-to-left language
  reloads a development build, and `tapline init` adds `language` and `region` for i18next and
  expo-localization. `size: "system"` restores the phone's text size, and text size and network both
  go back to normal when the session ends.
- The skill has `run` examples for the common shapes (a sheet, a form, a tab tour) and a list of ways
  to spend fewer calls.

Fixed, from the phone checks:
- Expo SDK 58 replaces the app's `fetch` with its own, which doesn't go through XMLHttpRequest, so the
  network condition, the `Network:` line, `wait_for` `network_idle` and the `[network]` failure logs
  missed `fetch` requests (offline still loaded a page). The global `fetch` is now covered too, and
  each request is counted once.
- `compare_screen` waits for the screen to stop moving before it saves or compares. A reference saved
  right after a tap that pushed a screen caught it sliding in, so the replay of a recorded flow always
  differed.

## 1.3.1 (2026-11-12)

Fixes only, from a tester's feedback on the sibling tool.

- Every tool refuses an argument it doesn't have (at the top level; `run` steps are checked as before): `Error bad_params: audit doesn't take labels; it takes types.`
  Before, the extra key was dropped silently and the call ran without it. The published tool schemas are unchanged.
- A "needs a person" list: `tapline doctor` ends with a `Needs a person:` block (the phone has not paired yet, the
  firewall rule is missing), and the first answer of an MCP session adds `Note: needs a person: …` once when no app
  is connected.
- QA and unattended runs are told to use a pinned release (`tapline-host@<version>`), not a development clone;
  `tapline doctor` warns when the host runs from a git work tree with uncommitted changes.
- An audit finding no longer names "the screen" when it knows more: it says `an element "Total" at @16,300 120x20` from the
  frame, text or label the app could still give.

## 1.3.0, "the Diagnostics Update" (2026-11-12)

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

## 1.2.0, "the Regression Update" (2026-11-12)

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
