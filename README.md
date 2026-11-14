# Tapline

**Let AI agents see and drive your own React Native app on a test phone.**

Tapline puts a small agent inside the development and TestFlight builds of your
React Native / Expo app. You pair your phone with your computer (a QR code, or in a
development build a single tap on Connect); from then on the app connects to your computer
over the same Wi-Fi, and an agent (Claude, Codex, anything that speaks MCP) uses it to read
the screen as named elements, tap, type, scroll, toggle, open deep links, read the app's
logs and take screenshots. It can also tell you which file and line of your code drew any
element on the screen (`inspect`), check the screen for accessibility problems (`audit`),
and ask a person before it touches anything like Buy or Delete. The phone stays next to the computer, on the same Wi-Fi (or the
computer is on a cable to the same router). Nothing is plugged in, and no Mac is needed.
A phone away from your Wi-Fi can connect over [Tailscale](https://tailscale.com); that
is optional and not part of the tested v1 setup.

> [!NOTE]
> Early. It has driven a real app on a physical iPhone, in a development build. TestFlight
> builds and Android haven't been tried yet; see [Status](#status).

## How it works

```
 your phone (same Wi-Fi)                              your computer
 ┌─────────────────────────┐    WebSocket over        ┌────────────────────────────┐
 │ your app (dev build or  │    the local network     │ tapline host  :7210        │
 │ TestFlight)             │ ───────────────────────▶ │   MCP server (stdio) ◀──── agent
 │   react-native-tapline │ ◀──── requests ───────── │   CLI                      │
 └─────────────────────────┘ ───── responses, logs ─▶ └────────────────────────────┘
```

iOS doesn't let an app tap or type in other apps; that is why remote-support apps on the
iPhone are view-only. But an app can always drive itself. Tapline's agent runs inside your
app, finds elements in its React tree, and calls their own handlers (`onPress`,
`onChangeText`, `scrollTo` …). The app connects out to your computer, so the phone needs
no open ports.

**Everyone uses their own setup.** Each developer or tester has their own computer, their
own Wi-Fi, their own phone and their own agents. The app build carries no
address and no secret, only an on switch, so one TestFlight build serves every tester:
each pairs the app with their own computer.

Tapline drives **your own app from the inside**. Its sibling project
[Tapwright](https://github.com/bo5amis/tapwright) drives **the whole phone from the
outside** (any app, system alerts) through Apple's UI automation (`pip install tapwright`).

## You need

- A React Native or Expo app: a development build, TestFlight, or Expo Go (there the live
  view runs at about 6 frames a second instead of 15).
- A computer with Node.js 20 or later, on the same Wi-Fi as your phone (or on a cable to
  the same router). Tailscale is optional.
- An MCP client for the agent, such as Claude Code.

## Quick start

`npm install -g tapline-host` on the computer (the `tapline` command), then `npx tapline-host init`
in your app's folder. Start with the [quickstart](docs/quickstart.md);
[docs/setup.md](docs/setup.md) has the detail, including building from a clone.

**The computer:**

```sh
claude mcp add tapline -- tapline mcp         # give Tapline to your agent (Claude Code)
# without a global install, from the clone:
claude mcp add tapline -- node <clone>/packages/host/dist/cli.js mcp
tapline skill install                         # teach your agents to test with it
```

Codex: add `[mcp_servers.tapline]` with `command = "tapline"` and `args = ["mcp"]` to
`~/.codex/config.toml`. Any other agent: run `tapline mcp` as an MCP server on stdio.

**The skill.** `tapline skill install` copies an agent skill ([skills/tapline](skills/tapline),
in the open [Agent Skills](https://agentskills.io) format) to `~/.claude/skills` for Claude
Code and to `~/.agents/skills` for Codex and other agents; `--project <dir>` installs it
for one project instead. It tells an agent how to set Tapline up, how to read its answers,
how to test well and report, and the mistakes agents new to it make. Ask for it by name:
`/tapline` in Claude Code, `$tapline` in Codex.

**The app**, in its folder:

```sh
npx tapline-host init
```

It installs the packages and sets up the entry file (`register` and `startTapline`; for Expo
Router its own `index.js`), `metro.config.js` with `withTapline`, Expo Router's
`app/+native-intent.ts` and `.env.local`. `--dry-run` shows what it would change. It warns if
your production profile turns Tapline on; run it again and nothing changes. To do it by hand,
see [setup](docs/setup.md#3-the-app). Set `EXPO_PUBLIC_TAPLINE_ENABLED=1` only in the build
profiles you test with, never in your App Store build.

**Pair:** ask your agent to pair your phone. In a development build whose code comes from
this computer's Metro, no scan is needed: open the app and tap **Connect** when it asks
"Connect for testing?" (the offer lasts 10 minutes and works once, on the local network
only). In a TestFlight or release build, the agent shows a QR code: scan it with the phone's
camera and tap **Connect**. The app remembers your computer and reconnects whenever it's
open (within about 2 seconds after your agent's server starts).
Then ask, for example: *"Sign up in MyApp with a test email
and tell me if anything looks broken."* [AGENTS.md](AGENTS.md) is the agent's guide; point
your agent at it.

## Tools

| Tool | What it does |
|---|---|
| `pair` | pairs a phone with this computer: a QR code and link (with the app's scheme), or with no scheme an offer a development build finds by itself |
| `inspect` | for an element on screen: the components that draw it, and the file and line of your code that wrote it (development builds) |
| `audit` | accessibility check of the screen: contrast, tap areas, labels, cut-off text, roles, overlaps, shared ids; each issue with its fix and, in development builds, `at <file>:<line>` |
| `run` | several steps in one call, each with an optional `expect`; stops at the first step that fails; `trace: true` lists each step |
| `apps`, `open_app` | connected apps; `open_app` picks one by session id, app id or name when several are connected |
| `look` | the screen as elements (role, text, id, position, actions), the app and the current route, with a screenshot (`screenshot: false` skips it; with `--screenshots file` a file path instead; `labels` draws each element's box and ref on it) |
| `check_layout` | automatic visual checks without a screenshot: small tap areas, cut-off edges, overlaps, low contrast, unnamed buttons, truncated text |
| `back` | go back, like the back button or swipe; it closes an open sheet or modal first (`Closed the sheet.`) |
| `swipe` | a finger dragged from `x0, y0` to `x1, y1` over `seconds`, through React Native's touch system (a sheet's swipe to close, a pan view) |
| `app_command` | the app's own test commands (switch language, sign in as a test user, sample data …) and the built-in light/dark switch |
| `wait_for` | wait until something appears or is gone, or the network is quiet |
| `compare_screen` | compare the screen with a saved reference picture: matches or differs (a share that may change, parts to ignore), what changed, where, marked in red; a check in scripts, with the pictures kept next to the script |
| `filmstrip` | several frames in one image, for animations and loading states |
| `record`, `replay` | save a test run as a script (shared format, version 2 for routes, version 1 still read) and replay it later, without an AI: `tapline replay <name\|file>… [--junit out.xml]` (exit 0 all held, 1 a step stopped, 2 couldn't start) |
| `viewer` | opens the live view in a browser on your computer, with what the agent does marked on it; you can tap, scroll and type there too. The agent never sees its link |
| `tap`, `long_press` | by `id` (the `testID` prop), label, visible text, ref from the last look, or x/y (`long_press` takes `seconds`, which Tapline ignores) |
| `type_text` | into an input; replace or append; optionally submit; refused where a person couldn't type |
| `scroll` | by a direction and a share of the scroll area (0.1 to 1, default 0.8), to the start or end, or to an element (`to: "target"`: one call brings it onto the screen, clear of the bars) |
| `toggle` | switches |
| `open_url` | deep links |
| `logs` | the app's console output and JavaScript errors, by level, text and count |
| `crash` | the app's last fatal JavaScript error, with its stack and components; every answer notes a crash |
| `session_report` | where this session's calls went: per tool, failures, and the waste to cut; also `tapline report` |
| `performance` | JS heap, frames, stalls and the slowest renders while you wait or after a tap; reload time in development builds; limits as a check in scripts |
| `reload` | reload the JavaScript bundle (development builds) |
| `wait` | let something load, then look |
| `journey` | test as a real user: `start` with a goal and a persona, act seeing only what a person sees (no ids, nothing scrolls by itself), `stop` with whether the goal was reached; it measures taps, time, wrong turns and hesitations, adds stress moments (a bad network, a double tap, background, rotate) and writes a visual report with a GIF in `~/.tapline/journeys` (the newest 20 kept), which `export` can put on a pull request or issue through your own `gh` |
| `ux_check` | the screen against usability basics: competing choices, one main action, thumb reach, icon-only buttons, cut-off text, contrast, target size, naming across screens, error and empty states; house rules from `--ux-rules FILE` |
| `drive` | go to a known place in one call (`drive {"to": "language"}`), or run a saved route (`route`, with `with` for its variables); follows the map's roads, checks every move and the arrival, repairs a stale road or stops with `off_route`; `then` goes on with `run` steps, `by` picks taps or a link, `account` names a test account |
| `map` | the app's places, roads, links, routes and reflexes, learned as the agent works, and where the app is now; `to` shows the way, `name`, `link`, `reflex`, `forget_reflex` and `forget` edit it |
| `media` | test pictures for an app's photo picker: `add` puts them in the phone's library through the app's own `expo-media-library` (with `confirm: true`), `picker: true` hands them to the next `expo-image-picker` call instead, `remove: true` deletes only what was added |

Every touch tool also takes `dry_run: true`: every check runs and nothing is touched, and the
answer says what it would do and whether a person's OK is needed. Password fields never show their
value, only one • per character. `run` steps take `if` and `optional`, to run a step only when
something is on screen. Actions take `brief: true` for an answer of at most 12 element lines.

### The Speed Update (1.6)

- **Known ground.** Tapline learns the app's *places* (a screen by its route pattern, never by its
  text), the *roads* between them and the deep *links* to them, and keeps them per app in
  `~/.tapline/maps/<app id>/`. After the first visit an agent calls `drive` and arrives in one call.
  Answers carry a `Place:` line. Nothing from a list row, typed text or a secret is saved. Tapline
  never navigates from inside the app: a drive is the app's own taps, or a deep link.
- **Reflexes.** A rule you or the agent declare in the map (`map {reflex}`) closes a known
  interruption, such as a rate prompt, at a place change or before a failure answer. Only declared
  reflexes run, and none that would need a person's OK.
- **The vault (test accounts, cards, addresses, identities, notes).** `--accounts FILE` holds values by name
  (AGENT-TOOLS 1.14 §20). The agent says `account: "tester2"` with `${account.username}` or
  `${account.password}`, or `${vault.home.street}` for any entry, as the whole text of a step, and the host
  types the value: it never reaches the agent as text, a log, a report, a script, a dialog or a recording
  (every form of it is scrubbed: as is, with spaces collapsed, JSON- and URL-encoded, with invisible marks).
  Answers show `value=<home's street>`. Screenshots show what the screen shows: a username in a plain
  field, and a password only if its field's "show password" toggle is on.
  - Kinds: `account` (username, password), `card` (number, expiry, cvc), `address` (street, city, postcode,
    country), `identity` (name, phone, email, birthday), `note` (text), and `phone` (Tapwright's passcode:
    held, never typed by Tapline). A version 1 accounts file still loads. `apps` limits an entry to apps.
  - **A card's fields are typed only with a person's OK, every time** (`Allow: type card "visa" number into
    "Card number" in Wayfare?`), and no grant covers one.
  - A plain file is for test data only (every start says it is not encrypted) and must be outside a git
    repository, or ignored by it. `tapline vault protect FILE` turns it into the protected form: Windows DPAPI
    for the current user, or the macOS keychain. Tapwright reads the same file.
  - Every use is a `vault` line in the audit log (the entry and the field, never the value).
- **A person's OK in the chat.** A touch that needs one opens the host's own dialog (Allow once /
  Don't allow) as well as the live view; the first answer wins. The same dialog says what to do when
  the app isn't open or an alert needs a person (`Needs a person: ...`), and the call goes on by
  itself when it clears.
- **Fewer seconds.** `tapline call` makes one tool call to a running `tapline host` in about 0.1 s;
  `--brief` shortens answers; `session_report` shows where the seconds went. Fast animations are
  opt-in (`app_command animations`) and need a new native build for their native layer. Faster
  settling is behind the app's `knowIdle` option and is off until it passes the device gate.

New flags (`tapline mcp` and `tapline host`):

| Flag | What it does |
|---|---|
| `--brief` | actions answer briefly; a call's `brief: false` overrides it; `look` is never brief |
| `--accounts FILE` | the vault file: test accounts, cards, addresses, identities, notes (see above; version 1 accounts files still load) |
| `--maps DIR` | keep each app's map in `DIR/<app id>/` instead of `~/.tapline/maps/<app id>/`, so a team and both tools can share a folder |
| `--no-dialog` | don't open the host's dialog for a person's OK or a "needs a person" moment; the live view still asks (`mcp`; for a host that hands dialogs to the model) |

`tapline host` is a standalone host in the foreground: it takes all the options of `mcp`, serves the
live view, and answers `tapline call <tool> '<json>' [--client NAME] [--json]`, which sends one call to
it (exit 0 an answer, 2 a refusal, 3 no host). A phone pairs with that host, not with an agent's own
MCP server. The host serves, on this computer only and with the bearer token:
`POST /api/<tool>` (the wire of `tapline call`; only the standalone host) and `GET /place?app=<id>`
(where the app is, from memory, without a call to the phone). [PROTOCOL.md](docs/PROTOCOL.md) has both.

Every action returns what changed on screen (or the whole list when the screen changed),
as text, so each step is one call. A change to something scrolled out of view is shown too,
marked `(off screen)`. Actions send no image unless you pass `screenshot: true`.
Actions refuse what a person couldn't tap, such as a button off screen or covered by
something, and say why (`Error not_actionable: covered: …`); with `force: true` the action
runs anyway and the answer says it was forced. A target hidden by an open
sheet or modal answers `covered: … is behind …; close that first.`; close the sheet and try
again. When the on-screen keyboard is up and an action targets something outside the focused
field, Tapline closes the keyboard first and says so (`Note: closed the keyboard first.`).
Typing into the next field of a form (one that shows above the keyboard) leaves the keyboard up, and answers say `Keyboard: shown`
or `Keyboard: hidden` when it comes or goes.
A look reads like this:

```
Screen 440x956 pt @3x · 4 elements (+12 below)
App: Demo (com.example.demo)
Route: login
e1 text "Welcome back" @24,120 200x32
e2 input "Email" id=email value="me@example.com" @24,200 354x44 [type]
e3 button "Log in" id=login-button @24,610 354x48 [tap, longPress]
e4 switch "Remember me" checked=true @330,301 51x31 [toggle]
```

The first line also counts the elements below and above the screen, so the agent knows there
is more to scroll to. Text longer than 200 characters is cut and ends with how much is
missing (`…(+57)`).

An action answers with the verb and the element, then what changed, then how long the
screen took to settle:

```
Tapped e3 button "Log in" id=login-button @24,610 354x48.
Same screen. Changes:
+ e13 button "Done" @24,700 354x48 [tap]
~ e5 text "3 items" (was "2 items")
Settled in 0.31 s.
```

When you touch the phone yourself between two of the agent's calls, its next answer ends
with `Note: a person used the app since your last look.`, and it has to look again before it
uses element numbers from before.

**Screenshots and tokens.** Images cost far more tokens than the element list, so agents
drive by text and take screenshots at checkpoints (`width: 300` is enough for a layout).
For a team of agents, `tapline mcp --screenshots file` returns screenshot paths instead of
images: a small, cheap vision model looks and reports in text, a mid-size model checks the
reports, and the lead only reads the summary. [AGENTS.md](AGENTS.md#screenshots-and-tokens)
has the recipe.

**Watch live.** Ask your agent to open the live view; it opens in a browser on your
computer. It shows the app's screen in a drawn phone, marks each tap and scroll the agent makes
with a ripple, and names each step under the phone in plain words (`Tap "Save trip"`,
`You tapped "Explore"`, or why a step was refused); **Steps** lists them all. **More** holds the
developer view (element boxes and refs, how the phone is reached, the frame rate) and the picture
quality. You can tap, drag, scroll and type in it as well (a drag goes to what takes a finger's drag,
such as a sheet's swipe to close, and scrolls otherwise): your
input goes first, the agent waits until you've been idle for 3 seconds, and **Pause agent**
stops it until you resume. The link carries a key and works on this computer only;
`tapline mcp --viewer remote` also opens it to your own devices on Tailscale, and
`--viewer off` turns it off. It runs only while someone watches. The page can show video
when a server offers it; Tapline's own doesn't yet.

**Several phones, several agents.** Each agent runs its own host; when 7210 is taken, the
next one takes 7211, and so on up to 7219. Each agent pairs its own phone with its own QR
code, so several agents can test on several phones at once. A phone works with one agent
at a time, and reconnects to the port it paired with: when agents restart in a different
order, pair again (or give each agent a fixed `--port`).

## Security

- The host listens on this computer's Wi-Fi/LAN address(es), on Tailscale if it runs, and
  on 127.0.0.1. Other devices on the same network can reach the port, but nothing connects
  without the one-time pairing code, and the person holding the phone approves it.
- A pairing code works once and expires after 10 minutes. Before connecting, the app asks
  "Connect for testing?" and names the computer. The host then hands the app its token
  (a random secret in `~/.tapline/token`), which the app keeps in the phone's keychain;
  other connections are closed.
- Traffic on the local network is plain WebSocket, not encrypted. Tailscale encrypts it
  when you use it. Use a Wi-Fi you trust.
- The live viewer stays on this computer unless you start the host with `--viewer remote`.
- The build carries no address and no token. With the switch off (your App Store build),
  Tapline does nothing at all, not even listen for pairing links.
- The agent inside your app can do whatever your app's UI can do. Turn it on only in
  builds you test with.
- **A person's OK for risky touches.** A touch on an element whose label or text has Buy,
  Purchase, Subscribe, Pay, Delete, Remove, Send, Post, Publish, Sign out, Log out or Erase
  needs a person. The live view asks you (Allow once / Don't allow), and so does the host's own
  dialog where the MCP client shows one (`--no-dialog` turns that off); the first answer wins, and
  the agent's call waits up to 120 seconds for it. Without a dialog the call answers
  `not_allowed: needs_confirmation` at once, and one allow lets the same call on the same element
  through once, within 120 seconds.
  `tapline mcp --policy FILE` sets your own words to confirm or to block; `--no-policy` turns
  it off, for a test phone with test data. The answer must come from the live view page in a
  browser or the host's dialog, and when the check can't be made, nothing is touched. This guards against an agent's
  mistakes. An agent that can run any command on your computer could still get around it (it could
  also edit the policy), so give such agents only the access you would give a person. The policy
  checks touches (`tap`, `long_press`, `toggle`, `swipe`); it doesn't check `type_text` with
  `submit`, `open_url` or `app_command`.
  **Grants (1.7).** A grant in the policy file (version 2) is your standing OK for a kind of touch, with limits
  (`perDay`, `perHour`, `until` within 30 days, quiet hours, a saved route). Only you make one: by editing the file,
  or by saying Allow to the host's dialog, which offers a grant after you allow a touch there. Payments, purchases and
  account deletion are never grantable. `tapline grants --policy FILE` lists the grants with today's counts and the last
  uses; `tapline grants --policy FILE --revoke-all` revokes them all at once (the live view's Pause only pauses: the
  grants stand when you resume). `tapline audit-log [--since <date or ISO time>]` shows what was done under a
  grant or your OK (in `~/.tapline/audit/`, 90 days); `tapline audit-log --delete` deletes it. `tapline doctor --policy FILE`
  says which grant is refused. These are commands for you, not tools the agent can call.
  **Scheduled runs (1.7).** A saved route can run by itself, with no model: `tapline schedule add <route> --at "09:00 daily"
  [--with caption=@captions.txt] [--name NAME] [--policy FILE] [--accounts FILE] [--maps DIR]` (or `--on-file FOLDER`
  to run when a new file appears; `--at` is `HH:MM daily`, `HH:MM weekdays` or an ISO date-time for one run). On Windows
  it registers a Task Scheduler task that wakes the PC and runs `tapline run-schedule <name>`; `tapline schedule list`
  and `tapline schedule remove NAME` do the rest. The schedule file is `~/.tapline/schedules/<name>.json`, and the
  policy, accounts and maps it names are in force (a running `tapline host` carries the run only when it runs with those same
  files; otherwise the run starts its own host, and skips if the app doesn't connect to it): grants and their limits apply to
  a scheduled run as to an agent (the counts are shared), the vault types by name, and a draft stops the run. A run needs the app open on the phone
  (Tapline can't open it); it waits up to 10 minutes for a phone in use, and otherwise says `skipped: the phone was in use`,
  `skipped: the previous run is still going`, `skipped: the app is not open` or `stopped: a draft is waiting for a person.`.
  Each run writes `~/.tapline/runs/<name>-<time>.json` (what was done, `Grants used:`, `Vault names used:`, never a value)
  and a `schedule` line in the audit log. Exit 0: it held, 1: it stopped, 2: it was skipped or couldn't start. On other
  systems the schedule is saved but not started: call `tapline run-schedule <name>` from cron or launchd.
- **Action log.** Every action, by the agent or a person, is one JSON line in
  `~/.tapline/log/`. Typed text is logged only as its length. Files are kept for 14 days;
  `--no-log` turns it off.
- **Pairing without a QR code** is for your own test phone on your own Wi-Fi. An offer exists
  only for 10 minutes after the agent calls `pair`, goes only to devices on the local network
  (not Tailscale, not through a proxy, never to a web page), and belongs to the first device that
  fetches it: no other device can pair with it. A device on the same Wi-Fi that asks before your
  phone does could take it; your phone then doesn't ask to connect, which is the sign. Use the QR
  code (`pair` with the scheme) on a network you don't trust. The Connect prompt is your consent. A tool that makes real
  touches on the same phone (Tapwright) could accept it, so keep this to phones that only you drive.
- To unpair one phone, open `<your-scheme>://tapline/forget` on it (deleting the app doesn't: iOS
  keeps the pairing in the keychain). To unpair every phone,
  delete `~/.tapline/token`; phones then need a new pairing code.
- **With a tool that makes real touches** (Tapwright) driving the same app, that tool tells the
  host before each touch, so its agent's touches aren't reported as a person's:
  `POST http://127.0.0.1:<port>/agent-touch` with `Authorization: Bearer <~/.tapline/token>`
  and `{"ms": <the touch's length, 0 to 10000>}`, answered 204. It is accepted only from this
  computer, and touch reports from then until the touch's end plus 1.5 s don't leave the
  "a person used the app" note. Hosts use the first free port of 7210–7219.

## Limits

- Only your app's own UI: it can't answer system dialogs (permission prompts, the share
  sheet, Face ID), type on the keyboard's keys, or reach other apps or the home screen.
  Tapwright covers those. Built with Tapline's native module (any new build of an Expo app
  with the SDK installed), an alert UIKit shows and the share sheet are seen: the agent gets an
  `Alert:` line and taps behind them are refused.
- Actions call your components' handlers; they aren't real touches. `swipe` drags through React
  Native's own touch system (a sheet's swipe to close, pan views, drawers); gestures built on
  react-native-gesture-handler, pinch, and native views React doesn't render (sliders, maps, web
  view contents) are out of reach, and so is a touch that a sheet in its own window (`Modal`)
  keeps for itself; `swipe` answers `no_action` for these, and for a drag along a list (use
  `scroll`).
- Native tab bars (Expo Router's `NativeTabs`) are drawn by iOS; Tapline lists their tabs
  (without a position) and switches them through navigation. Tabs that aren't selected and
  screens covered by another are left out of `look`, like they are for the user.
- The real-touch check sees what React draws, plus open sheets and dialogs (React Native's
  `Modal`) and, on an iPhone in portrait, the native tab bar: Tapline places it 49 points above
  the home indicator with its tabs spread evenly, so a tap there switches tabs and an element
  under it counts as covered. An element under the navigation bar iOS draws counts as covered
  too.
- A person's touch is noticed inside the app, but not inside a sheet with its own window
  (React Native's `Modal`) and not on what iOS draws.
- The app must be open on screen: iOS pauses apps in the background, and the connection
  comes back as soon as the app is opened again (the agent is told when it went to the
  background). Leaving or closing the app stops the agent at once; the forget link unpairs
  the phone. An open app finds a server that has just started within about 2 seconds. While
  an agent is connected, the screen stays on (with `expo-keep-awake`).
- Screenshots come from inside the app: about 25-65 ms each at the viewer's size on an
  iPhone once the app has settled, a few hundred while it starts up (measured). With Tapline's
  native module in the build, the live viewer shows about 15 frames a second while the screen
  changes, and one a second when it's still: its frames draw what is on screen without making
  iOS render again, and the phone pays about 12% of one core for it under a running animation
  (measured on an iPhone 14 Pro Max). Frames go out only as fast as the link takes them; on a
  slow link they are smaller while the screen moves and sharp again once it settles. Without
  the module (an older build), about 6 frames a second while the screen changes, since each
  frame then makes iOS draw the screen once more. Filmstrips show a few frames a second.
- The live viewer shows only the app's window: not the keyboard, the status bar or system
  alerts. Open it in a browser on the computer, not on the phone: switching apps on the phone pauses
  the app.
- iOS alerts can't be pressed from inside the app. Tapline shows them to the agent and stops
  it from tapping behind them (an `Alert.alert` always; one from native code, and the share
  sheet, with the native module); with `alerts: 'stand-in'` (test builds) it shows its own
  in-app alert instead, which the agent can tap.
- Release builds shorten component names, so element types read best in development
  builds. Elements with a `testID` (targeted as `id`) stay reliable everywhere.
- Screenshots need `react-native-view-shot` in the app; remembering the pairing across
  restarts needs `expo-secure-store` (or your own `storage`).

## Status

| | |
|---|---|
| Tested | the host (protocol, pairing codes, ports, sessions, timeouts, MCP tools, screenshot files and labels, change lists, app state, commands and waiting, record and replay, reference pictures, filmstrips, doctor and dev, the live viewer (its page, access, stream, control queue, the video player in the page), the v1.3 to v1.6 answers, the shared tool text and the agent skill with its installer; 1.1: `run`, scripts and replay, `audit`, `inspect`, the policy and a person's OK, dry runs, the action log, the shorter answers, pairing without a QR code, `init` and `doctor --app`; 1.2: visual checks with a pass bar and references next to scripts; 1.3: log filters, crash notes and `crash`, `performance` and its limits, logs on failed steps: 688 tests at 1.3; 749 at 1.4; 1.6: `drive`, `map`, routes, reflexes, test accounts, the host's dialog, `tapline call`: 1799 at 1.6); the in-app agent (React tree, hidden screens, routes and tabs, the real-touch check, change lists, layout checks, test commands, waiting, alerts and the stand-in, network tracking, keeping awake, the Metro helper, targets, every action, client, pairing, logs, screenshots, the live feed, sheets and the native tab bar in the real-touch check, the navigation bar, the v1.3 to v1.6 behaviour, the viewer feed's pace, a person's touches, the native module, `swipe`, the keyboard lines, Expo Go links and reloads; 1.1: source locations, the audit, dry runs, development offers and the Metro helper's offer; 1.3: a fatal error kept for the next connection, the performance sampler: 738 tests at 1.3; 845 at 1.4; 1.6: places, `move`, fast animations, the idle flag, loading waits: 1141 at 1.6); the shared benchmark that scores Tapline and Tapwright against docs/QUALITY-BAR.md (126 tests); the two together over a real WebSocket, paired and driven through MCP (7 tests) |
| On an iPhone | an Expo 57 app (React Native 0.86, new architecture) in a development build on iOS 26, on cellular through Tailscale: pairing (link, prompt, keychain, reconnect after a reload), `look` with positions, routes, native tabs and (labeled) screenshots, `tap` with the real-touch check (it caught a field scrolled under a large title), switching native tabs, `back`, `type_text`, `scroll`, changes after actions, `check_layout`, `open_url`, `logs`, `reload`; test commands (language switch to Arabic, right to left, and light mode), the stand-in alert (pressed, and taps behind it refused), `wait_for`, and background and foreground reports; loading Tapline through the Metro config, record and replay (also `tapline replay` without an agent), reference pictures and filmstrips; the live viewer in Chrome: frames, element boxes, the agent's actions, a person's taps, scrolls, typing and backspace from the viewer, closing a sheet and switching native tabs by clicking them in the viewer, the link opened from another site, the status while the app is in the background, closed and back (captures 30-65 ms once the app has settled, slower while it starts; no stutter from capturing, measured); `long_press` and `toggle`; the keyboard closing before a tap outside the focused field; `covered` for what an open sheet hides, and `back` closing the sheet; an app frozen for 20 seconds (`not_answering`, then working again by itself); the off-screen counts, the longer text cut and the in-app alert in front; scrolling to an element in one call, changes off screen, and the notes after a forced action and after actions without a list. Measured there by the shared benchmark over the local network: a tap, typing, a scroll and a toggle each answer in about 0.2 s, a look in 0.02 s, and the reliability checks (the right element, no false refusals, refusing what a person couldn't do) had no misses in three passes |
| Also on that iPhone (2026-11-10 and 11) | the note after a person's real touch on the phone; the native module in a new development build: an alert from native code and the share sheet seen as `Alert:` lines with taps behind them refused, and the live viewer at 15 frames a second under the lab animation over Wi-Fi with every viewer row of the benchmark passing (the longest gap 0.07 s, the phone paying about 12% of one core); typing into the next field with the keyboard up, `Keyboard:` lines, `back` closing a sheet by its backdrop; `swipe` closing a sheet through React Native's touch system, and a person's drag in the viewer doing the same; the app turned to landscape (positions, taps, scrolling and sharp viewer frames); the viewer in Firefox; the app back in front and answering within 0.7 s |
| A second app (2026-11-11) | a trip-planner demo app with React Navigation tabs, first in Expo Go (no build: pairing with Expo's exp:// address, reloads keeping the pairing, Tapline's own Connect prompt listed as an alert with taps behind it refused) and then in its own development build: routes on tab screens, ids on form fields and tab buttons, test commands (sample data, a test user, a reset), the live view's captions and steps in Firefox and Chromium, and a keyboard-hidden button tapped after closing the keyboard |
| 1.1 on that iPhone (2026-11-12) | `inspect` on every element of the demo app (48 of 48), `run` and `record`/`replay`, `audit` on its screens and on the lab, the policy (Sign out's dry run, its refusal, Allow and Don't allow from the live view, the prompt by keyboard in a browser), pairing without a QR code (the prompt in 3 s, connected 1 s after Connect), and a first-time agent passing the lab's charter with `run`, `audit` and `inspect` in 51 calls; `tapline init` on a fresh create-expo-app, whose iOS bundle then builds |
| Numbers | every speed, live view and reliability result with its target, and 1.1 against 1.0 on the same day: [docs/benchmarks.md](docs/benchmarks.md) |
| Not yet | TestFlight and release builds, network tracking and keeping the screen on (on a device), a second phone, scanning the QR code with the camera, Android |

## Repository

```
packages/host           tapline-host: WebSocket server, MCP server, CLI (Node 20+)
packages/react-native   react-native-tapline: the in-app agent (TypeScript, no native code)
CHANGELOG.md            what changed in each release
docs/quickstart.md      the short way to start
docs/setup.md           step-by-step setup
docs/PROTOCOL.md        the wire protocol
docs/benchmarks.md      measured speed, live view and reliability
AGENTS.md               the guide for agents
skills/tapline          the agent skill (Agent Skills format): `tapline skill install`
```

`npm install`, `npm run build`, `npm test` from the repository root.

## License

MIT. Tapline is not affiliated with Apple, Tailscale or Expo.
