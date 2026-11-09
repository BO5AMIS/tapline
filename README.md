# Tapline

**Let AI agents see and drive your own React Native app on your phone, from anywhere.**

Tapline puts a small agent inside the development and TestFlight builds of your
React Native / Expo app. You pair your phone with your computer by scanning a QR code;
from then on the app connects to your computer over [Tailscale](https://tailscale.com),
and an agent (Claude, Codex, anything that speaks MCP) uses it to read the screen as
named elements, press, type, scroll, toggle, open deep links, read the app's logs and
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
| `apps`, `select_app` | connected apps; pick one when several are connected |
| `look` | the screen as elements (type, text, testID, position, actions) and the current route, plus a screenshot (an image or a file path; `labels` draws each element's box and ref on it) |
| `check_layout` | automatic visual checks without a screenshot: small tap areas, cut-off edges, overlaps, low contrast, unnamed buttons, truncated text |
| `back` | go back, like the back button or swipe |
| `press`, `long_press` | by `testID`, label, visible text, ref from the last look, or x/y |
| `type_text` | into an input; replace or append; optionally submit |
| `scroll` | by a direction and amount, or to the start or end |
| `toggle` | switches |
| `open_url` | deep links |
| `logs` | the app's console output and JavaScript errors |
| `reload` | reload the JavaScript bundle (development builds) |
| `wait` | let something load, then look |

Every action returns what changed on screen (or the whole list when the screen changed),
as text, so each step is one call. Actions refuse what a person couldn't tap, such as a button
off screen or covered by something, and say why. A look reads like this:

```
Screen 402x874 @3x (points) - 4 elements
e1 Text "Welcome back" @24,120 200x32
e2 TextInput "Email" testID=email value="me@example.com" @24,200 354x44 [type, submit]
e3 button "Log in" testID=login-button @24,610 354x48 [press, longPress]
e4 switch "Remember me" checked=true @330,301 51x31 [toggle]
```

**Screenshots and tokens.** Images cost far more tokens than the element list, so agents
drive by text and take screenshots at checkpoints (`width: 300` is enough for a layout).
For a team of agents, `tapline mcp --screenshots file` returns screenshot paths instead of
images: a small, cheap vision model looks and reports in text, a mid-size model checks the
reports, and the lead only reads the summary. [AGENTS.md](AGENTS.md#screenshots-and-tokens)
has the recipe.

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
- The real-touch check sees what React draws. Bars iOS draws on top of the app (a native
  tab bar or navigation bar) can cover an element without Tapline noticing.
- The app must be open on screen: iOS pauses apps in the background, and the connection
  comes back when the app is opened again.
- Release builds shorten component names, so element types read best in development
  builds. `testID`s keep targeting reliable everywhere.
- Screenshots need `react-native-view-shot` in the app; remembering the pairing across
  restarts needs `expo-secure-store` (or your own `storage`).

## Status

| | |
|---|---|
| Tested | the host (protocol, pairing codes, ports, sessions, timeouts, MCP tools, screenshot files and labels, change lists: 105 tests); the in-app agent (React tree, hidden screens, routes and tabs, the real-touch check, change lists, layout checks, targets, every action, client, pairing, logs, screenshots: 235 tests); the two together over a real WebSocket, paired and driven through MCP (7 tests) |
| On an iPhone | an Expo 57 app (React Native 0.86, new architecture) in a development build on iOS 26, on cellular through Tailscale: pairing (link, prompt, keychain, reconnect after a reload), `look` with positions, routes, native tabs and (labeled) screenshots, `press` with the real-touch check (it caught a field scrolled under a large title), switching native tabs, `back`, `type_text`, `scroll`, changes after actions, `check_layout`, `open_url`, `logs`, `reload` |
| Not yet | TestFlight and release builds, `long_press` and `toggle` on a device, focused-input detection, scanning the QR code with the camera, Android |

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
