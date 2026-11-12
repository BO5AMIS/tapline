# Tapline: guide for agents

Through Tapline's MCP tools you can see and operate the user's own React Native app on
their real test phone, on the same Wi-Fi as the computer, to test it. Tapline works inside that one
app; it can't reach other apps, system dialogs or the home screen. This guide covers
setting Tapline up for a developer, then testing well and safely.

Each person uses their own setup: their own computer, Wi-Fi, phone and
agents. The phone pairs with the computer you run on, by a QR code. Never set up a phone
to use someone else's computer or network.

## Setting it up for a developer

Do the work on the computer and in the app's code yourself; ask the user only for what
needs their hands, their accounts or their decisions. Follow [docs/setup.md](docs/setup.md).

**Computer side**

1. `npm install -g tapline-host` puts the `tapline` command on the PATH (from a clone
   instead: `npm install`, `npm run build`, then `npm install -g ./packages/host`, or use
   `node <clone>/packages/host/dist/cli.js`). `tapline doctor` checks the whole computer side
   and says what to fix.
   QA or unattended runs use a pinned release, never a development clone: `npm install -g
   tapline-host@<version>` here and `react-native-tapline@<version>` in the app. A clone
   mid-change runs whatever is in the tree (`tapline doctor` warns about a dirty work tree).
2. The computer and the phone must be on the same Wi-Fi (or the computer on a cable to the
   same router). `tapline doctor` fails when the computer has no Wi-Fi or LAN address; ask
   the user to join the phone's Wi-Fi. Tailscale is optional, only for a phone away from
   that Wi-Fi (not part of v1); its warnings can be ignored.
3. `tapline info` prints this computer's address and the code the app needs. The token in
   `~/.tapline/token` is a secret: never print it or put it in chat, commits or files.
4. Add the MCP server to your client (Claude Code: `claude mcp add tapline -- tapline mcp`;
   Codex: `[mcp_servers.tapline]` with `command = "tapline"`, `args = ["mcp"]` in
   `~/.codex/config.toml`). Each agent's host takes its own port (7210, else up to 7219).
   `tapline skill install` gives the user's agents the skill in `skills/tapline` (the short
   form of this guide, for Claude Code, Codex and other agents).
5. Windows: if the phone can't connect later, the firewall is the usual cause; the rule
   (ports 7210-7219) is in docs/setup.md (it needs an admin prompt the user approves).

**App side** (the user's repository)

`npx tapline-host init` in the app's folder does steps 1 to 5 in one go. Use `--dry-run` to see the
changes first, or `--no-install` to skip the install. It edits only what it can edit safely, says
exactly what to add by hand where a file is too custom, and warns when the production profile turns
Tapline on. Read its output, then go on with step 6. By hand:

1. Install `react-native-tapline`, `expo-secure-store` (remembers the pairing) and, for
   screenshots, `react-native-view-shot` (`npx expo install react-native-tapline
   expo-secure-store react-native-view-shot`).
2. Make `import 'react-native-tapline/register'` the first line of the app's entry file.
   For Expo Router apps that means a new `index.js` (register, then `expo-router/entry`)
   and `"main": "index.js"`. Getting this wrong is the most common failure: the tree comes
   back empty with "No React roots recorded".
3. Add `startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' })` after
   it. The build carries no address and no token. Wrap the Metro config in `withTapline` from
   `react-native-tapline/metro`: it lets a development build find the computer by itself (step 9).
4. Expo Router apps: add `app/+native-intent.ts` that returns `null` for
   `isTaplineLink(path)` (docs/setup.md), or pairing links open a "not found" screen.
5. Set `EXPO_PUBLIC_TAPLINE_ENABLED=1` only in the profiles used for testing (development,
   TestFlight; `.env.local` for local Metro), never in the production profile.
6. Suggest `testID`s (the React Native prop) on the controls you'll test, and add them if
   the user agrees. You target them as `{id}`.
7. A new native dependency (`expo-secure-store`, `react-native-view-shot`) means a new
   build; ask the user before starting EAS builds or TestFlight submissions (they cost
   build minutes and reach testers).
8. A development build on the same Wi-Fi loads its JavaScript from Metro over plain `http`;
   nothing more is needed. Optional, later (not part of v1): a development build away from
   the computer's Wi-Fi loads its JavaScript over Tailscale, and iOS refuses plain `http`
   there, so serve Metro over `https` with Tailscale Serve (docs/setup.md, step 4). Check
   `tailscale serve status` first and pick a free port; don't replace what the user already
   serves.
9. Prove the chain. **A development build** that loads its JavaScript from this computer: call
   `pair` with no scheme and ask the user to open the app and tap Connect; it asks by itself within
   a few seconds (the offer is open for 10 minutes, works once, and only on the local network).
   **Any other build:** call `pair` with the app's URL scheme (`scheme` in app.json) and show
   the user the QR code (it is also saved as a PNG; the result gives the path). They scan
   it with the phone on the same Wi-Fi and tap Connect; when they're using the phone itself, give them
   the link to tap instead. Then `apps` should list the app and `look` should show its
   screen.

## Testing an app

1. `apps` shows the connected app (`open_app {app}` when there are several; `app` is a
   session id, app id or name, and several matches give `ambiguous`). If none is
   connected: a phone that never paired needs `pair`; a paired one only needs the user to
   open the app with the phone on the same Wi-Fi; after your server starts, an app that is open finds it
   by itself within about 2 seconds. The app must stay on screen while you work: iOS pauses
   it in the background (also when the user switches to chat with you on the same phone).
   Tapline only works while its app is open in front, so when the user leaves or closes the
   app you stop at once; the forget link (`<scheme>://tapline/forget`) unpairs the phone.
2. `look` first. The header reads `Screen 440x956 pt @3x · 49 elements (+12 below)`, then
   `App:`, `Route:`, and `Alert:` or `Network:` when they apply. The brackets count the
   elements below and above the screen: scroll to reach them. Elements read
   `e3 button "Log in" id=login-button @24,610 354x48 [tap, longPress]`: ref, role, text,
   `id` (the `testID` prop), position in points, size, actions. Roles are `button`, `input`,
   `text`, `header`, `switch`, `slider`, `image`, `scroll`, `tab` and so on. The actions are
   `tap`, `longPress`, `type`, `toggle` and `scroll`. The ones a role implies aren't listed: a
   button, tab or link can be tapped, an input typed into, a switch toggled and a scroll view
   scrolled; other actions are listed in brackets. A list holds up to 200 elements, then
   `(+N more below; scroll)`. Text longer than 200 characters is cut and ends with what is
   missing, `…(+57)`; `wait_for` with a `text` checks all of it. A screenshot comes with it (the app needs
   `react-native-view-shot`); pass `screenshot: false` when the list is enough.
3. Every action answers with the verb and the element (`Tapped e3 button "Log in"
   id=login-button.`), then either `Same screen. Changes:` with lines for
   what changed (`+` new, `-` gone, `~` changed with its old value (a long one cut to what
   changed), `↕` moved; unchanged
   elements keep their refs) or `No visible change.`, or the full list when the screen
   changed. Then `Settled in 0.31 s.`: the app answers once React hasn't committed for
   100 ms (2 s at most; when it's still changing then, a `Note:` says positions may be
   mid-change). **Read it before the next step**: check that the action did what
   you meant, not just that it didn't fail. `look: false` returns only the first line; the
   next answer's changes then cover both actions, and a `Note:` says so. Call
   `look` when you need the full list or to see the screen (next section). The `Route:` line
   names the screen you're on. `Note:` lines at the end tell you things worth knowing, such
   as `Note: a person used the app since your last look.`
4. Target by `{id}` when there is one, else by visible `{text}` or `{label}`, else by
   `{ref}` from the latest look. `look` numbers from `e1`; after an action, elements still
   on screen keep their refs and new ones count on from the highest ref given, also when the
   answer is a full list. So a ref you still remember never points at another element: it
   answers `not_found`. Use `{x, y}` only when nothing else fits. An `ambiguous` error lists
   `Candidates:`: pick one by its ref or add `index` (it works with `id`, `label` and
   `text`). After a person acts in the live viewer or touches the phone itself, `{ref}`
   targets fail with `stale` until you `look` again; `id`, `label` and `text` keep working.
   A `not_found` adds `Closest:` with up to 3 elements whose id, label or text is close to what
   you asked for, each with its ref (and `off screen, below` when it is): use one of those.
5. Screens load and animate. Actions already wait for the screen to settle. If a spinner
   shows or content is missing, `wait_for` what you expect (`text`, `id` or `label`;
   `gone: true` for a spinner; `network_idle` for loading) instead of acting on a
   half-loaded screen. A `Network:` line in the list means requests are still running;
   failed requests show up in `logs` as `[network]` lines. Use a fixed `wait` only for
   animations.
6. Inputs: `type_text` with the input as target; `replace` (default) clears it first,
   `submit` presses return. Typing is refused where a person couldn't type (an input that is
   off screen, covered or behind an alert), with the same reasons and `force` as a tap. Toggles: `toggle`. Lists: an
   action (`tap`, `long_press`, `toggle`, `type_text`) on an element that is in the list but off screen
   scrolls it into view and acts in the same call: `Scrolled to it, then tapped …`. To only bring
   one into view, `scroll` with it as `target` and `to: "target"`. A row a long list hasn't made yet
   isn't in the list (`+N below`): `scroll` until it appears, or `to: "end"`. Otherwise `scroll` until what you need
   appears (`down` shows what is below), or `to: "end"`. `amount` is a share of the scroll
   area, 0.1 to 1 (default 0.8). `Keyboard: shown` or `Keyboard: hidden` in an answer says the
   on-screen keyboard came or went. While it is up and you act on something outside the focused
   field, Tapline closes the keyboard first and the answer ends with
   `Note: closed the keyboard first.` Typing into another field that shows above the keyboard
   moves the focus there and leaves the keyboard up, as a person filling a form does.
7. **When something breaks, say why.** Read `logs` after anything that misbehaves: JavaScript errors
   and warnings often explain a broken screen. `level: "warning"` keeps warnings and errors, `grep`
   keeps lines with a text, `limit` caps the count; reuse the `Latest:` value as `since`. Check them at
   the end of a run too. A failed `run` or `replay` step already adds `Logs (since step 4):`.
   `Note: the app crashed: …` on any answer means a fatal JavaScript error ended the app: `crash` shows
   it with its stack (the app's own frames marked `*`) and the components it was in. `Note: the app
   disconnected during this call (it may have crashed …)` means it went away without a JavaScript error:
   possibly a native crash, which Tapline can't read (Tapwright's `crash` can). `performance` measures for
   `seconds` (optionally after a `tap`): JS heap, JS frames (fps, the lowest second, drops over 50 ms),
   the longest JS stall and, in a development build, the slowest renders by component; `launch: true`
   times a JavaScript reload to the first settled screen (development builds). CPU and the app's whole
   memory aren't measured here. In `run` and scripts, `expect: {"under": {"drops": 0, "busy_ms": 200}}`
   on a `performance` step is a check.
8. Deep links (`open_url`) jump straight to a screen; `back` goes back like the back
   button, and closes what is open on top first: with a sheet or modal open, its first line
   is `Closed the sheet.` It calls the sheet's own close request, or taps its backdrop as a
   person would; when the sheet has neither, it answers `no_action`, names the sheet, and you
   tap the sheet's own close control. Native tab bars (Expo Router's `NativeTabs`) are drawn by iOS: their tabs appear
   as `tab` elements without a position, and tapping one switches tabs. `look` leaves out
   tabs that aren't selected and screens covered by another. In development builds, `reload`
   starts over from a fresh JavaScript state.
9. Errors read `Error <code>: <message>`. The codes are `not_found`, `ambiguous`,
   `not_actionable`, `stale`, `busy`, `paused`, `in_background`, `reconnecting`,
   `not_connected`, `not_answering`, `timeout`, `bad_params`, `unsupported`, `not_allowed`
   (item 12), `expect_failed` (item 11) and `internal`.
   `not_answering` means the app is connected but stopped answering: try once more; if it
   repeats, ask the user to close the app and open it again (Tapline can't close apps). An
   action that a person couldn't do is `not_actionable`, and the message starts with the
   reason: `disabled`, `off_screen` (no scroll brings it on screen; the message says why), `covered` (dismiss what
   covers it), `under_tab_bar`, `behind_alert` or `no_action` (nothing at that point takes
   the action). That is often a real bug worth reporting. Pass `force: true` only when you've
   decided the check is wrong; the answer then ends `Note: forced (covered): a person
   couldn't have done this.`, which belongs in your report. A target hidden by an open sheet or modal answers
   `covered: … is behind <the line of what is in front>; close that first.` Here `force`
   doesn't help: close the sheet (its own close control, or `back`) and try again.
10. An `Alert:` line means the app showed an alert, or (in a build with Tapline's native
   module) that iOS shows one over the app or the share sheet is open (`Alert: "Share sheet"`).
   An OS alert can't be tapped from Tapline: ask the user to tap the button you need (say
   which), or use Tapwright, and actions are refused (`behind_alert`) until it's answered. When the app runs with Tapline's stand-in, the
   alert's buttons are ordinary elements: tap them.
11. **Several steps, accessibility, the code, a check before acting.** `run` does several steps in
   one call and stops at the first that fails or whose `expect` doesn't hold (`expect_failed`).
   `audit` checks the screen's accessibility (contrast, tap areas, labels, roles, cut-off text,
   overlaps, shared ids), each issue with its fix and, in a development build, the file and line.
   `inspect` an element (development builds) to say where to fix it: the components, the file and
   line that wrote it, and that line. `dry_run: true` on a touch or on `run` runs every check and
   touches nothing.
12. **A person's OK.** A touch on a button whose label says Buy, Pay, Delete, Send, Post, Sign out
   and the like answers `not_allowed: needs_confirmation`, and the live view asks the person; when
   they allow it, make the same call again (once). A `blocked` word is refused outright. Never look
   for another way to the same result, and never confirm for them. The user can change the words
   with `tapline mcp --policy FILE`, or turn it off for a test phone with `--no-policy`.
13. `app_command` without a name lists what the app offers for testing (for example
   switching the language, a test sign-in or sample data); run one with `name` and `args`.
   `appearance` (light / dark) and `network` (`offline`, `3g`, `lossy`, `normal`: the app's own
   requests; every answer says `Network: 3g (Tapline).` while it is on, and it goes back to normal by
   itself when the session ends) are always there. Apps can offer the standard `language`
   (`{ language: "ar" }`), `region` (`{ region: "QA" }`) and `text_size` (`{ size: "xl" }`, `xs` to
   `xxxl` and `ax1` to `ax5`; it needs the app to use `useTaplineFontScale()`); `tapline init` adds
   `language` and `region` for i18next and expo-localization. A switch to or from a right-to-left
   language reloads a development build. Use them to reach a state quickly and to check stress views:
   dark mode, right-to-left languages, large text, a bad network, instead of the phone's Settings.
   Put things back when you're done.
14. What you tap calls the element's handler; it isn't a real touch. `swipe` (`x0, y0, x1, y1`,
   `seconds`) drags a finger through React Native's own touch system: a sheet's swipe to close,
   a pan view, a drawer. Gestures that react-native-gesture-handler or a native view handle
   (swipeable rows built on it, sliders, maps) answer `no_action`: say that you couldn't test
   them (or use Tapwright) rather than guessing. Lists move with `scroll`, not `swipe`.

## Repeatable runs

- `record { action: "start", name }` before a flow worth keeping (sign-up, checkout,
  settings), then act as usual; `record { action: "stop" }` saves it. Targets are saved by
  id, else label, else text, so give key controls `testID`s. Add `wait_for` steps as the
  checks ("Thanks for your order" appears), and `compare_screen` where how the screen looks
  matters: right after an action it becomes that step's `expect: {"matches": name}`, and its
  reference picture is copied next to the script.
- `replay { name }` runs it again and stops at the first step that fails or lands on a
  different screen. Use it after a change to check nothing broke; the user can run
  `tapline replay <name>` without an agent (`--update-references` saves new pictures when a
  change is intended). Scripts keep typed text, but never a password field's: no real passwords.
- `compare_screen { name }` saves a reference picture of a screen the first time; later it
  answers `Matches` or `Differs` against `threshold` (the percent that may change, default
  0.5), with the regions that changed and the elements there, and on a difference a picture
  with the changes in red. `ignore` paints out what always changes (a clock: `{id}` or a rect).
  Use the same `width` each time, and `update: true` when the change is intended. In `run` a
  `compare_screen` step, or `expect: {"matches": name}` on a step, is a check that stops the
  batch with `expect_failed` when the screen differs.
- `filmstrip` (optionally `tap` first) captures several frames in one image for
  animations, transitions and loading states.

## As a real user (journeys)

When the question is whether people can find, understand and finish a feature, not only whether it
works, run a journey (AGENT-TOOLS 1.12 §17).
- `journey { start: true, goal, persona }`. Build personas for this app's own users with the user
  ([skills/tapline/references/personas.md](skills/tapline/references/personas.md) has the recipe). From
  then on you see the app in a user's eyes: only what shows on the glass (cut to its scroll views and
  above the keyboard), no ids or labels, and nothing scrolls by itself. Target by ref or visible text,
  and scroll the way a person would. `open_url` and `app_command` are shortcuts a user doesn't have:
  only what the start's `allow` names. `eyes: "agent"` switches back, and the report says so.
- Act as that person would, then `journey { stop: true, reached }`. The answer gives the taps to the
  goal, the time, wrong turns, hesitations and dead ends, the findings by severity, and the report
  folder in `~/.tapline/journeys` (report.md, report.html, a GIF of the run, a picture per finding).
  The newest 20 reports are kept. Typed text never goes into a report.
- `ux_check` checks a screen against usability basics (competing choices, one main action, thumb
  reach, icon-only buttons, cut-off text, contrast, target size, naming across screens, error and
  empty states). `tapline mcp --ux-rules FILE` adds house rules: text ones for you to judge,
  `{"max_taps_to_goal": N}` and `{"way_back": true}` checked by the tool.
- Stress moments: `journey { stress: { kind }, survives }`. `network` (a `mode`) and `double_tap` (a
  `target`; both taps in one request, 80 ms apart) happen at once. `background`, `rotate` and a
  relaunch outside a development build need a person; say `done: true` when they have, and Tapline
  checks that the app shows it happened before it counts the moment. `survives` names visible text,
  or a step whose screen must still be there.
- `stop` with `export: { to: "pr" | "issue", repo, pr?, confirm: true }` puts the report on GitHub
  through the user's own `gh`, only when the user asked for that (`public: true` for a public
  repository).
- `media { add: [paths], confirm: true }` puts test pictures in the phone's photo library through the
  app's own `expo-media-library`; `picker: true` (with `confirm: true` too) hands them to the next
  image-picker call instead (the report marks it "picker skipped"). Ask the user first. `remove: true` deletes only what this
  phone's session added. At most 10 pictures and 20 MB per call.

## Watching together

- `viewer` opens the live view in a browser on the user's computer: the app's screen as
  it changes, with your taps and scrolls marked. You don't get the link: its key can approve
  touches that need a person's OK (`--viewer-link` gives it, for benchmarks and scripts).
  Offer it when they want to watch, or to do a step themselves (sign in with their own
  password, finish a step you can't). The page is at `/viewer` and `/`. In a build with
  Tapline's native module it shows about 15 frames a second while the screen changes (smaller
  frames while it moves on a slow link) and one a second when it's still; in an older build
  about 6 a second while the screen changes. It can show video when a server offers it
  (Tapline's own doesn't yet).
- The user can tap, scroll and type there too, and their input goes first: your next action
  waits until they've been idle for 3 seconds. It fails with `busy` after 30 seconds of their
  input, and with `paused` while they've paused you. Then wait, or ask them.
- The viewer is for people. Don't read its stream yourself; `look` is cheaper and gives refs.
  The `viewer` tool also reports how long the app's captures take and whether they made it
  stutter.

## Screenshots and tokens

Images are the most expensive thing you read. A phone screenshot at the default width costs
about 1,000 image tokens, and every one stays in your context for the rest of the session.
The element list is text: far cheaper, and enough to drive the app. Spend images on seeing,
not on driving.

- **Check by text first.** `check_layout` finds small tap areas, elements cut off at the
  edges, overlaps, low contrast, unnamed buttons and truncated text from the tree, without
  an image. Run it on each new screen; spend images on what it can't judge.
- **Drive by text.** Actions send no image unless you pass `screenshot: true`; `look` sends
  one unless you pass `screenshot: false`. Look at a picture at checkpoints only: a new screen,
  before and after a
  visual change, when the list suggests something is off, and at the end. `labels: true`
  draws each element's box and ref on the screenshot, so a helper can report by ref.
- **Shrink them.** `look` with `width: 300` is enough to judge a layout (about a quarter of
  the tokens); keep the default 600 to read text.
- **Keep images out of the lead agent.** When you coordinate helpers, run the host with
  `--screenshots file` (`claude mcp add tapline -- tapline mcp --screenshots file`). `look` then
  saves each screenshot in `~/.tapline/shots` (newest 50 kept) and returns its path instead of
  the image, so you pass paths, not pictures.
- **Let a small model look.** Give the paths to a short-lived helper on the smallest
  vision-capable model your tool offers (Claude Code: Haiku; Codex: Terra; other tools: their
  small fast model). Small models are fast and cheap at this and good at it. Give each helper
  one screen (one image, or a few of the same moment), its element list, and a short
  checklist: layout and alignment, cut-off or overlapping text, contrast, images that didn't
  load, anything that doesn't match the design. Ask for text only, in a fixed shape: the
  screen, then each issue with where it is (element ref or region), what's wrong and how sure
  it is, in about 100 words.
- **Verify in the middle.** When findings matter, a mid-size model (Claude Code: Sonnet; or
  your tool's equivalent) reads the helpers' text, not the images. It checks each claim against
  the element list and the logs, drops duplicates and doubtful ones, and sends a helper back
  for a closer look (a wider screenshot) only where a claim is unclear.
- **The lead gets the summary.** The lead receives the verified problems and decides what to
  do next. It opens an image itself only when a decision really needs it: one image, small.
- **Motion: stills, not video.** Never feed a recording to the lead. Take a few screenshots
  (4 to 8) across the moment that matters and let a helper describe what changed between them.
- **Don't look twice.** If the element list hasn't changed since the last screenshot and
  nothing animates, the screen hasn't either; skip the new screenshot.

## Reporting

`session_report` (or `tapline report` in a terminal) says where this session's calls went: calls per
tool, failures by code, and the waste to cut (a `look` right after an answer that had the changes, a
retry after `not_found`, scroll hunts, actions that could have been one `run`). Read it after a long
session.

For each problem: what you did (the steps, short), what you expected, what happened, and
where (screen, element `id` or text). Quote the relevant log lines. Separate real bugs
from things you couldn't test (blocked by login, a missing test account, a system dialog,
a gesture-only control). Note screens that took more than a few seconds to load.

## Rules

- **It is the user's real phone and their real app data.** Don't buy, subscribe, send
  messages or email, post, invite people, delete data, or change account, privacy or
  security settings, unless the user asked for exactly that step. Ask when unsure.
- Use the test accounts and test data the user gives you. Don't sign in with credentials
  you find in the app or its logs.
- Don't read or repeat private content you see beyond what the test needs.
- The token is a secret: never print it in chat, logs you write, issues or commits. A
  pairing link isn't the token, but for 10 minutes it lets a phone connect: show it to the
  user only.
- Tapline belongs only in development and TestFlight builds. If you're asked to make a
  release build, check that the production profile doesn't set
  `EXPO_PUBLIC_TAPLINE_ENABLED`.
