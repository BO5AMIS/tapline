# Quickstart

Let an AI agent test your React Native app on your own iPhone. The computer side takes
about two minutes. The app side is a few lines of code and one new app build. Detail and
every option: [setup.md](setup.md).

## What you need

- A computer with Node.js 20 or later and git (Windows, macOS or Linux).
- An iPhone, and your own Expo or React Native app that you can build as a development
  build or a TestFlight build. Expo Go can't run it.
- [Tailscale](https://tailscale.com), signed in on the computer and on the phone. Keep it
  on on the phone while you test.
- An AI agent client that speaks MCP, such as Claude Code.

## On the computer

Times are measured from a clean copy on Windows 11 with Node 22.

```sh
git clone https://github.com/<owner>/tapline
cd tapline
npm install                        # about 40 s
npm run build                      # about 10 s
npm install -g ./packages/host     # puts `tapline` on your PATH
tapline doctor                     # about 5 s
claude mcp add tapline -- tapline mcp
tapline skill install              # the skill that teaches agents to test with Tapline
```

- `npm install` ends with a few `deprecated` warnings and "6 low severity
  vulnerabilities". They come from the test tools; ignore them.
- `tapline doctor` checks Node, Tailscale, the token, the ports and, on Windows, the
  firewall. It says how to fix anything that's missing. Fix that before you go on.
- Without the global install, run `node /path/to/tapline/packages/host/dist/cli.js` where
  this page says `tapline`.
- `claude mcp add` gives Tapline to Claude Code. Codex: `[mcp_servers.tapline]` with
  `command = "tapline"` and `args = ["mcp"]` in `~/.codex/config.toml`. Other agents: run
  `tapline mcp` as an MCP server on stdio.
- `tapline skill install` puts the skill in `~/.claude/skills` (Claude Code) and
  `~/.agents/skills` (Codex and other agents).

## On the phone

Everything here is in your app's code, except the QR code at the end. See
[setup.md](setup.md#3-the-app) for each step in full.

1. Install the SDK in your app: from the clone, `npm pack -w @tapline/react-native`, then
   `npm install /path/to/tapline-react-native-0.1.0.tgz` in your app. Also
   `npx expo install expo-secure-store` (remembers the pairing), and optionally
   `react-native-view-shot` (screenshots) and `expo-keep-awake` (screen stays on).
2. Make this the first line of the app's entry file. For Expo Router, that's a new
   `index.js` (this, then `import 'expo-router/entry'`) and `"main": "index.js"` in
   package.json:
   ```js
   import '@tapline/react-native/register';
   ```
3. Right after it, start Tapline:
   ```js
   import { startTapline } from '@tapline/react-native';
   startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });
   ```
4. Expo Router only: add `app/+native-intent.ts` so pairing links don't open a "not found"
   screen (the three lines are in setup.md).
5. Set `EXPO_PUBLIC_TAPLINE_ENABLED=1` only in your development and TestFlight profiles
   in `eas.json` (and in `.env.local` for local Metro). Never in production. With it off,
   Tapline does nothing at all.
6. **Make one new build.** The new native modules need it, and so does the switch. Its
   time is your build system's (EAS, Xcode), not Tapline's. Install it on the phone.
7. Ask your agent to pair your phone. It shows a QR code. With Tailscale on, scan it with
   the phone's camera and open the app. It asks **Connect for testing?** and names your
   computer: tap **Connect**. The code works once and expires after 10 minutes. From then
   on the app reconnects by itself whenever it's open.

## First test

Keep the app open on the phone. Ask your agent: "Open the login screen in the app and tap
Log in." It makes three calls.

**1. `apps`** lists the connected app:

```
Connected apps:
* s-3f9a  Example app [com.example.app] on ios 26.5, install 4c1d2e, connected 14s ago
* = selected.
```

**2. `look`** reads the screen as a list, with a screenshot:

```
Screen 440x956 pt @3x · 3 elements
App: Example app (com.example.app)
Route: login
e1 text "Welcome back" @24,120 200x32
e2 input "Email" id=email @24,200 354x44 [type]
e3 button "Log in" id=login-button @24,610 354x48 [tap, longPress]
```

**3. `tap`** with `{id: "login-button"}` answers with what it did and what changed:

```
Tapped e3 button "Log in" id=login-button @24,610 354x48.
Same screen. Changes:
+ e4 text "Check your email and password" @24,670 354x20
Settled in 0.31 s.
```

A good answer names the element it tapped and says what changed. Give the controls you
test a `testID`: the agent targets it as `id`, which keeps tests stable.

## Watching and stopping

- Ask the agent for the `viewer`. It gives a link to open in a browser on your computer:
  the app's screen as it changes, with the agent's taps marked. The viewer shows who is
  driving, you or the agent. You can tap and type there too, and your input goes first.
- **Pause agent** in the viewer stops the agent until you press Resume.
- On the phone, leaving or closing the app stops the agent at once. Tapline only works
  while its app is open in front.
- Open `<your-scheme>://tapline/forget` on the phone to unpair it for good. The agent's
  `pair` answer shows the exact link.

## Personal phone or dedicated device

**Your own phone.** Tapline can only act inside the one app that carries the SDK. It can't
reach other apps, system dialogs or the home screen. You approved the pairing on the phone
yourself, and the viewer shows who is driving.

**A dedicated test device.** While an agent is connected, the screen is kept awake (needs
`expo-keep-awake`). The app finds an agent that has just started within about 2 seconds, by
itself. Nobody needs to touch the device between runs, as long as the app stays open.

## If something doesn't work

Run `tapline doctor` first. Then the three most common failures:

- **The tree comes back empty, with "No React roots recorded".** `register` isn't the
  first import of the entry file. For Expo Router, use your own `index.js` as in step 2.
- **The phone can't connect.** Check that Tailscale is on, on both, and that the agent is
  running. On Windows the usual cause is the firewall. As admin:
  ```powershell
  New-NetFirewallRule -DisplayName "Tapline" -Direction Inbound -Protocol TCP -LocalPort 7210-7219 -RemoteAddress 100.64.0.0/10 -Action Allow
  ```
- **The agent gets `not_connected` (or `in_background`).** The app isn't open in front.
  Open it on the phone and call `apps` again.

More in the troubleshooting table in [setup.md](setup.md#troubleshooting).
