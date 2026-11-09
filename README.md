# Tapline

**Let AI agents see and drive your own React Native app on your phone, from anywhere.**

Tapline puts a small agent inside the development and TestFlight builds of your
React Native / Expo app. You pair your phone with your computer by scanning a QR code;
from then on the app connects to your computer over [Tailscale](https://tailscale.com),
and an agent (Claude, Codex, anything that speaks MCP) uses it to read the screen as
named elements, tap, type, scroll, toggle, open deep links, read the app's logs and
take screenshots. The phone can be anywhere: on cellular, on another Wi-Fi, across the
world. Nothing is plugged in, and no Mac is needed.

> [!NOTE]
> Early. It has driven a real app on a physical iPhone over cellular through Tailscale, in a
> development build. TestFlight builds and Android haven't been tried yet; see
> [Status](#status).

## How it works

```
 your phone (anywhere)                                your computer
 ┌─────────────────────────┐    WebSocket over        ┌────────────────────────────┐
 │ your app (dev build or  │    Tailscale             │ tapline host  :7210        │
 │ TestFlight)             │ ───────────────────────▶ │   MCP server (stdio) ◀──── agent
 │   @tapline/react-native │ ◀──── requests ───────── │   CLI                      │
 └─────────────────────────┘ ───── responses, logs ─▶ └────────────────────────────┘
```

iOS doesn't let an app tap or type in other apps; that is why remote-support apps on the
iPhone are view-only. But an app can always drive itself. Tapline's agent runs inside your
app, finds elements in its React tree, and calls their own handlers (`onPress`,
`onChangeText`, `scrollTo` …). The app connects out to your computer, so the phone needs
no open ports.

**Everyone uses their own setup.** Each developer or tester has their own computer, their
own Tailscale network, their own phone and their own agents. The app build carries no
address and no secret, only an on switch, so one TestFlight build serves every tester:
each pairs the app with their own computer.

Tapline drives **your own app from the inside**, from anywhere. Its sibling project
[Tapwright](https://github.com/<owner>/tapwright) drives **the whole phone from the
outside** (any app, system alerts) through Apple's UI automation.

## You need

- A React Native or Expo app you build yourself (development builds or TestFlight;
  Expo Go can't load it).
- A computer with Node.js 20 or later and Tailscale, and Tailscale on your phone, in your
  own Tailscale network.
- An MCP client for the agent, such as Claude Code.

## Quick start

Not on npm yet: clone this repository and build it (`npm install && npm run build`).
[docs/setup.md](docs/setup.md) has every step, including installing from the clone.

**The computer:**

```sh
claude mcp add tapline -- tapline mcp         # give Tapline to your agent (Claude Code)
```

**The app**, first lines of its entry file:

```js
import '@tapline/react-native/register';      // before anything imports React
import { startTapline } from '@tapline/react-native';

startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });
```

Set `EXPO_PUBLIC_TAPLINE_ENABLED=1` only in the build profiles you test with, never in your
App Store build. Expo Router apps also add a three-line `app/+native-intent.ts`
([setup](docs/setup.md#3-the-app)).

**Pair:** ask your agent to pair your phone. It shows a QR code; scan it with the phone's
camera, tap **Connect** in the app, and you're done. The app remembers your computer and
reconnects whenever it's open. Then ask, for example: *"Sign up in MyApp with a test email
and tell me if anything looks broken."* [AGENTS.md](AGENTS.md) is the agent's guide; point
your agent at it.

## Tools

| Tool | What it does |
|---|---|
| `pair` | a QR code and link that pair a phone with this computer |
| `apps`, `open_app` | connected apps; `open_app` picks one by session id, app id or name when several are connected |
| `look` | the screen as elements (role, text, id, position, actions), the app and the current route; `screenshot: true` adds an image (or a file path; `labels` draws each element's box and ref on it) |
| `check_layout` | automatic visual checks without a screenshot: small tap areas, cut-off edges, overlaps, low contrast, unnamed buttons, truncated text |
| `back` | go back, like the back button or swipe |
| `app_command` | the app's own test commands (switch language, sign in as a test user, sample data …) and the built-in light/dark switch |
| `wait_for` | wait until something appears or is gone, or the network is quiet |
| `compare_screen` | compare the screen with a saved reference picture: what changed, where, marked in red |
| `filmstrip` | several frames in one image, for animations and loading states |
| `record`, `replay` | save a test run as a script and replay it later, without an AI (also `tapline replay`) |
| `viewer` | a link to watch the app live in a browser, with what the agent does marked on it; you can tap, scroll and type there too |
| `tap`, `long_press` | by `id` (the `testID` prop), label, visible text, ref from the last look, or x/y (`long_press` takes `seconds`, which Tapline ignores) |
| `type_text` | into an input; replace or append; optionally submit |
| `scroll` | by a direction and a share of the scroll area (0.1 to 1, default 0.8), or to the start or end |
| `toggle` | switches |
| `open_url` | deep links |
| `logs` | the app's console output and JavaScript errors |
| `reload` | reload the JavaScript bundle (development builds) |
| `wait` | let something load, then look |

Every action returns what changed on screen (or the whole list when the screen changed),
as text, so each step is one call. No image is sent unless you pass `screenshot: true`.
Actions refuse what a person couldn't tap, such as a button off screen or covered by
something, and say why (`Error not_actionable: covered: …`). A look reads like this:

```
Screen 440x956 pt @3x · 4 elements
App: Demo (com.example.demo)
Route: login
e1 text "Welcome back" @24,120 200x32
e2 input "Email" id=email value="me@example.com" @24,200 354x44 [type]
e3 button "Log in" id=login-button @24,610 354x48 [tap, longPress]
e4 switch "Remember me" checked=true @330,301 51x31 [toggle]
```

An action answers with the verb and the element, then what changed, then how long the
screen took to settle:

```
Tapped e3 button "Log in" id=login-button @24,610 354x48.
Same screen. Changes:
+ e13 button "Done" @24,700 354x48 [tap]
~ e5 text "3 items" (was "2 items")
Settled in 0.31 s.
```

**Screenshots and tokens.** Images cost far more tokens than the element list, so agents
drive by text and take screenshots at checkpoints (`width: 300` is enough for a layout).
For a team of agents, `tapline mcp --screenshots file` returns screenshot paths instead of
images: a small, cheap vision model looks and reports in text, a mid-size model checks the
reports, and the lead only reads the summary. [AGENTS.md](AGENTS.md#screenshots-and-tokens)
has the recipe.

**Watch live.** Ask your agent for the viewer link and open it in a browser on your
computer. It shows the app's screen as it changes, marks each tap and scroll the agent makes,
and can draw a box around every element. You can tap, scroll and type in it as well: your
input goes first, the agent waits until you've been idle for 3 seconds, and **Pause agent**
stops it until you resume. The link carries a key and works on this computer only;
`tapline mcp --viewer remote` also opens it to your own devices on Tailscale, and
`--viewer off` turns it off. It runs only while someone watches.

**Several phones, several agents.** Each agent runs its own host; when 7210 is taken, the
next one takes 7211, and so on up to 7219. Each agent pairs its own phone with its own QR
code, so several agents can test on several phones at once. A phone works with one agent
at a time, and reconnects to the port it paired with: when agents restart in a different
order, pair again (or give each agent a fixed `--port`).

## Security

- The host listens only on your Tailscale address and 127.0.0.1, so only devices in your
  own Tailscale network can reach it.
- A pairing code works once and expires after 10 minutes. Before connecting, the app asks
  "Connect for testing?" and names the computer. The host then hands the app its token
  (a random secret in `~/.tapline/token`), which the app keeps in the phone's keychain;
  other connections are closed. Tailscale encrypts the traffic.
- The build carries no address and no token. With the switch off (your App Store build),
  Tapline does nothing at all, not even listen for pairing links.
- The agent inside your app can do whatever your app's UI can do. Turn it on only in
  builds you test with.
- To unpair one phone, open `<your-scheme>://tapline/forget` on it. To unpair every phone,
  delete `~/.tapline/token`; phones then need a new pairing code.

## Limits

- Only your app's own UI: no system dialogs (permission prompts, the share sheet, Face
  ID), no keyboard, no other apps, no home screen. Tapwright covers those.
- Actions call your components' handlers; they aren't real touches. Gesture-only controls
  (swipe-to-delete, drag, pinch) and native views React doesn't render (maps, web view
  contents) are out of reach.
- Native tab bars (Expo Router's `NativeTabs`) are drawn by iOS; Tapline lists their tabs
  (without a position) and switches them through navigation. Tabs that aren't selected and
  screens covered by another are left out of `look`, like they are for the user.
- The real-touch check sees what React draws, plus open sheets and dialogs (React Native's
  `Modal`) and, on an iPhone in portrait, the native tab bar: Tapline places it 49 points above
  the home indicator with its tabs spread evenly, so a tap there switches tabs and an element
  under it counts as covered. A navigation bar iOS draws can still cover an element without
  Tapline noticing.
- The app must be open on screen: iOS pauses apps in the background, and the connection
  comes back as soon as the app is opened again (the agent is told when it went to the
  background). While an agent is connected, the screen stays on (with `expo-keep-awake`).
- Screenshots come from inside the app: about 30-65 ms each at the viewer's size on an
  iPhone once the app has settled, a few hundred while it starts up (measured). The live viewer shows a frame when the screen changes, a few a second
  for about a second after each action, and one a second otherwise; filmstrips also show a
  few frames a second. That's enough to follow what happens and to see loading states, not
  for quick animations.
- The live viewer shows only the app's window: not the keyboard, the status bar or system
  alerts. Open it on another device than the phone: switching apps on the phone pauses the
  app.
- iOS alerts can't be pressed from inside the app. Tapline shows them to the agent and stops
  it from tapping behind them; with `alerts: 'stand-in'` (test builds) it shows its own in-app
  alert instead, which the agent can tap.
- Release builds shorten component names, so element types read best in development
  builds. Elements with a `testID` (targeted as `id`) stay reliable everywhere.
- Screenshots need `react-native-view-shot` in the app; remembering the pairing across
  restarts needs `expo-secure-store` (or your own `storage`).

## Status

| | |
|---|---|
| Tested | the host (protocol, pairing codes, ports, sessions, timeouts, MCP tools, screenshot files and labels, change lists, app state, commands and waiting, record and replay, reference pictures, filmstrips, doctor and dev, the live viewer (its page, access, stream, control queue): 203 tests); the in-app agent (React tree, hidden screens, routes and tabs, the real-touch check, change lists, layout checks, test commands, waiting, alerts and the stand-in, network tracking, keeping awake, the Metro helper, targets, every action, client, pairing, logs, screenshots, the live feed, sheets and the native tab bar in the real-touch check: 354 tests); the two together over a real WebSocket, paired and driven through MCP (7 tests) |
| On an iPhone | an Expo 57 app (React Native 0.86, new architecture) in a development build on iOS 26, on cellular through Tailscale: pairing (link, prompt, keychain, reconnect after a reload), `look` with positions, routes, native tabs and (labeled) screenshots, `tap` with the real-touch check (it caught a field scrolled under a large title), switching native tabs, `back`, `type_text`, `scroll`, changes after actions, `check_layout`, `open_url`, `logs`, `reload`; test commands (language switch to Arabic, right to left, and light mode), the stand-in alert (pressed, and taps behind it refused), `wait_for`, and background and foreground reports; loading Tapline through the Metro config, record and replay (also `tapline replay` without an agent), reference pictures and filmstrips; the live viewer in Chrome: frames, element boxes, the agent's actions, a person's taps, scrolls, typing and backspace from the viewer, closing a sheet and switching native tabs by clicking them in the viewer, the link opened from another site, the status while the app is in the background, closed and back (captures 30-65 ms once the app has settled, slower while it starts; no stutter from capturing, measured) |
| Not yet | TestFlight and release builds, network tracking and keeping the screen on (on a device), `long_press` and `toggle` on a device, focused-input detection, scanning the QR code with the camera, Android |

## Repository

```
packages/host           @tapline/host: WebSocket server, MCP server, CLI (Node 20+)
packages/react-native   @tapline/react-native: the in-app agent (TypeScript, no native code)
docs/setup.md           step-by-step setup
docs/PROTOCOL.md        the wire protocol
AGENTS.md               the guide for agents
```

`npm install`, `npm run build`, `npm test` from the repository root.

## License

MIT. Tapline is not affiliated with Apple, Tailscale or Expo.
