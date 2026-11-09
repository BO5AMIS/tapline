# Tapline: guide for agents

Through Tapline's MCP tools you can see and operate the user's own React Native app on
their real phone, from wherever the phone is, to test it. Tapline works inside that one
app; it can't reach other apps, system dialogs or the home screen. This guide covers
setting Tapline up for a developer, then testing well and safely.

Each person uses their own setup: their own computer, Tailscale network, phone and
agents. The phone pairs with the computer you run on, by a QR code. Never set up a phone
to use someone else's computer or Tailscale network.

## Setting it up for a developer

Do the work on the computer and in the app's code yourself; ask the user only for what
needs their hands, their accounts or their decisions. Follow [docs/setup.md](docs/setup.md).

**Computer side**

1. Clone and build Tapline (`npm install`, `npm run build`), then `npm install -g
   ./packages/host` (or use `node <clone>/packages/host/dist/cli.js`). `tapline doctor`
   checks the whole computer side and says what to fix.
2. Check that Tailscale is running (`tailscale ip -4` prints a `100.x.y.z` address). If it
   isn't installed or signed in, ask the user; it needs their account.
3. `tapline info` prints this computer's address and the code the app needs. The token in
   `~/.tapline/token` is a secret: never print it or put it in chat, commits or files.
4. Add the MCP server to your client (Claude Code: `claude mcp add tapline -- tapline mcp`).
   Each agent's host takes its own port (7210, else up to 7219).
5. Windows: if the phone can't connect later, the firewall is the usual cause; the rule
   (ports 7210-7219) is in docs/setup.md (it needs an admin prompt the user approves).

**App side** (the user's repository)

1. Install `@tapline/react-native` (a tarball from `npm pack` until it's on npm),
   `expo-secure-store` (remembers the pairing) and, for screenshots,
   `react-native-view-shot`.
2. Make `import '@tapline/react-native/register'` the first line of the app's entry file.
   For Expo Router apps that means a new `index.js` (register, then `expo-router/entry`)
   and `"main": "index.js"`. Getting this wrong is the most common failure: the tree comes
   back empty with "No React roots recorded".
3. Add `startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' })` after
   it. The build carries no address and no token.
4. Expo Router apps: add `app/+native-intent.ts` that returns `null` for
   `isTaplineLink(path)` (docs/setup.md), or pairing links open a "not found" screen.
5. Set `EXPO_PUBLIC_TAPLINE_ENABLED=1` only in the profiles used for testing (development,
   TestFlight; `.env.local` for local Metro), never in the production profile.
6. Suggest `testID`s on the controls you'll test, and add them if the user agrees.
7. A new native dependency (`expo-secure-store`, `react-native-view-shot`) means a new
   build; ask the user before starting EAS builds or TestFlight submissions (they cost
   build minutes and reach testers).
8. A development build away from the computer's Wi-Fi loads its JavaScript over Tailscale,
   and iOS refuses plain `http` there: serve Metro over `https` with Tailscale Serve
   (docs/setup.md, step 4). Check `tailscale serve status` first and pick a free port; don't
   replace what the user already serves.
9. Prove the chain: call `pair` with the app's URL scheme (`scheme` in app.json) and show
   the user the QR code (it is also saved as a PNG; the result gives the path). They scan
   it with Tailscale on and tap Connect; when they're using the phone itself, give them
   the link to tap instead. Then `apps` should list the app and `look` should show its
   screen.

## Testing an app

1. `apps` shows the connected app (`select_app` when there are several). If none is
   connected: a phone that never paired needs `pair`; a paired one only needs the user to
   open the app with Tailscale on. The app must stay on screen while you work: iOS pauses
   it in the background (also when the user switches to chat with you on the same phone).
2. `look` first. It lists elements as `ref type "text" testID=… @x,y WxH [actions]`
   (positions in points), plus a screenshot when the app has `react-native-view-shot`.
3. Every action returns what changed after it (`+` new, `-` gone, `~` changed with its old
   value, `↕` moved; unchanged elements keep their refs), or the full list when the screen
   changed, as text. **Read it before the next step**: check that the action did what you
   meant, not just that it didn't fail. Call `look` when you need the full list or to see
   the screen (next section). The `Route:` line names the screen you're on.
4. Target by `testID` when there is one, else by visible `text` or `label`, else by
   `ref` from the latest look (refs change when the screen changes). Use `x`/`y` only
   when nothing else fits. An `ambiguous` error lists candidates: pick one by its ref or
   add `index`.
5. Screens load and animate. If a spinner shows or content is missing, `wait_for` what you
   expect (`text`, `testID` or `label`; `gone: true` for a spinner; `network_idle` for
   loading) instead of acting on a half-loaded screen. A `Network:` line in the list means
   requests are still running; failed requests show up in `logs` as `[network]` lines.
   Use a fixed `wait` only for animations.
6. Inputs: `type_text` with the input as target; `replace` (default) clears it first,
   `submit` presses return. Toggles: `toggle`. Lists: `scroll` until what you need
   appears (`down` shows what is below), or `to: "end"`.
7. Read `logs` after anything that misbehaves: JavaScript errors and warnings often
   explain a broken screen. Check them at the end of a run too.
8. Deep links (`open_url`) jump straight to a screen; `back` goes back like the back
   button. Native tab bars (Expo Router's `NativeTabs`) are drawn by iOS: their tabs appear
   as `tab` elements without a position, and pressing one switches tabs. `look` leaves out
   tabs that aren't selected and screens covered by another. In development builds, `reload`
   starts over from a fresh JavaScript state.
9. An action that a person couldn't do is refused with the reason: the element is off
   screen (scroll to it) or something covers it (dismiss it). That is often a real bug
   worth reporting. Pass `force: true` only when you've decided the check is wrong.
10. An `Alert:` line means the app showed an alert. An OS alert can't be pressed from
   Tapline: ask the user to tap the button you need (say which), and actions are refused
   until it's answered. When the app runs with Tapline's stand-in, the alert's buttons are
   ordinary elements: press them.
11. `app_command` without a name lists what the app offers for testing (for example
   switching the language, a test sign-in or sample data); run one with `name` and `args`.
   `appearance` (light / dark) is always there. Use them to reach a state quickly and to
   check stress views: dark mode, right-to-left languages. Put things back when you're done.
12. What you press calls the element's handler; it isn't a real touch. If a control only
   reacts to gestures (swipe-to-delete, drag), say that you couldn't test it rather than
   guessing.

## Repeatable runs

- `record { action: "start", name }` before a flow worth keeping (sign-up, checkout,
  settings), then act as usual; `record { action: "stop" }` saves it. Targets are saved by
  testID, else label, else text, so give key controls testIDs. Add `wait_for` steps as the
  checks ("Thanks for your order" appears).
- `replay { name }` runs it again and stops at the first step that fails or lands on a
  different screen. Use it after a change to check nothing broke; the user can run
  `tapline replay <name>` without an agent. Scripts keep typed text: no real passwords.
- `compare_screen { name }` saves a reference picture of a screen the first time and later
  shows what changed (how much, where, which elements, marked in red). Use the same `width`
  each time, and `update: true` when the change is intended.
- `filmstrip` (optionally `press` first) captures several frames in one image for
  animations, transitions and loading states.

## Screenshots and tokens

Images are the most expensive thing you read. A phone screenshot at the default width costs
about 1,000 image tokens, and every one stays in your context for the rest of the session.
The element list is text: far cheaper, and enough to drive the app. Spend images on seeing,
not on driving.

- **Check by text first.** `check_layout` finds small tap areas, elements cut off at the
  edges, overlaps, low contrast, unnamed buttons and truncated text from the tree, without
  an image. Run it on each new screen; spend images on what it can't judge.
- **Drive by text.** Take screenshots at checkpoints only: a new screen, before and after a
  visual change, when the list suggests something is off, and at the end. `labels: true`
  draws each element's box and ref on the screenshot, so a helper can report by ref.
- **Shrink them.** `look` with `width: 300` is enough to judge a layout (about a quarter of
  the tokens); keep the default 600 to read text; `screenshot: false` when you only need refs.
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

For each problem: what you did (the steps, short), what you expected, what happened, and
where (screen, element `testID` or text). Quote the relevant log lines. Separate real bugs
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
