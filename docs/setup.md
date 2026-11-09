# Setup

About fifteen minutes: your computer once, each app once, then a QR code per phone.

Everyone who tests sets this up for themselves: their own computer, their own Tailscale
network, their own phone and their own agents. Nobody needs anyone else's computer or
Tailscale network, and the app build is the same for everyone.

## 1. Tailscale

Install [Tailscale](https://tailscale.com) on your computer and on your phone, signed in to
your own Tailscale network. Keep it on on the phone while you test.

## 2. The computer (host)

Node.js 20 or later.

Tapline isn't on npm yet. From a clone:

```sh
git clone https://github.com/<owner>/tapline
cd tapline
npm install
npm run build
npm install -g ./packages/host     # puts `tapline` on your PATH
```

Or skip the global install and run `node /path/to/tapline/packages/host/dist/cli.js`
wherever this guide says `tapline`.

**Give it to your agent.** The MCP server is the host: while the agent is running, your
phone can connect.

```sh
claude mcp add tapline -- tapline mcp           # Claude Code
```

If your agent hands screenshots to smaller helper models, add `--screenshots file`: `look`
then returns a file path instead of the image ([AGENTS.md](../AGENTS.md#screenshots-and-tokens)).
The live viewer (the agent's `viewer` tool gives its link) opens on this computer only; add
`--viewer remote` to also open it from your own devices on Tailscale, or `--viewer off`.
Other MCP clients: run `tapline mcp` as a stdio server. To only watch connections and
app logs, without an agent: `tapline host --scheme <your app's scheme>` (it also prints a
pairing QR code).

`tapline info` shows this computer's name and address and the code the app needs. A token
is created on the first run and kept in `~/.tapline/token` (`%USERPROFILE%\.tapline\token`
on Windows). You never copy it anywhere: pairing hands it to the app.

The host listens on your Tailscale address and 127.0.0.1 only, on port 7210. When 7210 is
taken (another agent's host), it takes the next free port up to 7219, so several agents
can run at once, each with its own phone. Options: `--port` (or `TAPLINE_PORT`) for a fixed
port, `--host` (comma-separated addresses to listen on instead). If Tailscale isn't
running, it listens on 127.0.0.1 only and says so.

**Windows:** the first time, Windows Firewall may ask whether Node.js may accept
connections. Allow it on **private** networks (Tailscale counts as private). Without that
prompt, as admin:

```powershell
New-NetFirewallRule -DisplayName "Tapline" -Direction Inbound -Protocol TCP -LocalPort 7210-7219 -RemoteAddress 100.64.0.0/10 -Action Allow
```

## 3. The app

Your own React Native or Expo app, in a development build or a TestFlight build. Expo Go
can't run it.

**Install the package.** Until it's on npm, pack it from the clone and install the
tarball in your app (Metro handles a tarball better than a linked folder):

```sh
# in the tapline clone
npm pack -w @tapline/react-native           # makes tapline-react-native-0.1.0.tgz
# in your app
npm install /path/to/tapline-react-native-0.1.0.tgz
npx expo install expo-secure-store          # remembers the paired computer
npx expo install react-native-view-shot     # optional: screenshots
```

Both have native code: a new development build or TestFlight build includes them.
Without `expo-secure-store`, pairing works but lasts only until the app restarts (or pass
your own `storage`, see below).

**Load `register` first.** It has to run before React starts. The simplest way is Metro,
in `metro.config.js` (it only does this when `EXPO_PUBLIC_TAPLINE_ENABLED=1`, so store
builds are untouched):

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withTapline } = require('@tapline/react-native/metro');

module.exports = withTapline(getDefaultConfig(__dirname));
```

Then call `startTapline` (below) anywhere that loads at startup, such as the top of
`app/_layout.tsx`. Or, without the Metro helper, import it on the first line of the app's
entry file:

- Expo Router (`"main": "expo-router/entry"` in package.json): create `index.js` and set
  `"main": "index.js"`:

  ```js
  import '@tapline/react-native/register';
  import 'expo-router/entry';
  ```

- Other Expo apps: the first line of `index.js`, above `registerRootComponent`.
- Bare React Native: the first line of `index.js`, above `AppRegistry.registerComponent`.

**Start it.** In the same file, after the `register` line:

```js
import { startTapline } from '@tapline/react-native';

startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });
```

That's all the build carries: an on switch. No address, no token. With the switch off,
`startTapline` does nothing at all. With it on, the app reconnects to the computer it was
paired with whenever it's open (1, 2, 4 … 30 s between tries while the computer can't be
reached), and pairs when a pairing link opens it. It never throws into the app.
`stopTapline()` shuts it down. Optional: `app: { name, id, version, build }` to name the
app in `apps`, and `storage` (`getItem`, `setItem`, `removeItem`, all async) to keep the
pairing somewhere other than `expo-secure-store`.

**Expo Router: let pairing links through.** Expo Router would open a "not found" screen
for a pairing link. Add `app/+native-intent.ts` (next to your other routes):

```ts
import { isTaplineLink } from '@tapline/react-native';

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return isTaplineLink(path) ? null : path;
}
```

If you already have one, return `null` for Tapline links before your own handling.

**Turn it on only where you test.** The switch isn't a secret, so it can live in
`eas.json`, in the profiles you test with and never in the production one:

```json
{
  "build": {
    "development": { "developmentClient": true, "distribution": "internal", "env": { "EXPO_PUBLIC_TAPLINE_ENABLED": "1" } },
    "testflight": { "distribution": "store", "env": { "EXPO_PUBLIC_TAPLINE_ENABLED": "1" } },
    "production": { "distribution": "store" }
  }
}
```

Locally, put `EXPO_PUBLIC_TAPLINE_ENABLED=1` in `.env.local` (or `.env`) while you run
Metro for a development build.

**Optional: test commands.** Give agents shortcuts no screen offers: register a command
where its state lives, and remove it on unmount (`registerTaplineCommand` returns the
remover). The agent lists them with `app_command`.

```tsx
import { registerTaplineCommand } from '@tapline/react-native';

useEffect(
  () =>
    registerTaplineCommand('language', {
      description: 'Switch the language (args: { code: "en" | "ar" })',
      run: async ({ code }) => {
        if (code !== 'en' && code !== 'ar') throw new Error('code must be "en" or "ar"');
        await setLanguage(code);
        return { language: code };
      },
    }),
  [setLanguage],
);
```

Good candidates: sign in as a test user, load sample data, reset to a fresh state, set the
date. Registering does nothing in builds where Tapline is off. `appearance` (light / dark)
is built in.

**Optional: alerts the agent can tap.** iOS alerts can't be tapped from inside the app,
so Tapline tells the agent about them and asks it to get the user to tap. In test builds you
can pass `alerts: 'stand-in'` to `startTapline`: alerts then show as Tapline's own in-app
box, whose buttons the agent taps like any other. Tapline's own "Connect for testing?"
prompt always stays a real iOS alert.

**Give important elements a `testID`.** Agents can also target visible text, labels and
positions, but `testID`s keep tests stable (the agent targets them as `id`):

```jsx
<Pressable testID="login-button" onPress={login}><Text>Log in</Text></Pressable>
```

## 4. Build, pair and check

- Development build: `eas build --profile development --platform ios` (or
  `npx expo run:ios`), install it, start Metro.
- TestFlight: `eas build --profile testflight --platform ios --auto-submit`, then install
  from TestFlight. Every tester uses the same build and pairs it with their own computer.

**A development build away from your Wi-Fi.** The build loads its JavaScript from Metro on
your computer. iOS refuses plain `http` to a Tailscale address ("App Transport Security
policy requires the use of a secure connection"), so serve Metro over `https` with
[Tailscale Serve](https://tailscale.com/kb/1312/serve) (MagicDNS and HTTPS certificates on in
your Tailscale admin console). `tapline dev` does it in one go, without touching anything
else Tailscale serves:

```sh
tapline dev -- npx expo start --dev-client --port 8081
```

It serves `http://127.0.0.1:8081` on `https://<computer>.<tailnet>.ts.net:8443` and runs
your Metro command with `EXPO_PACKAGER_PROXY_URL` set (`--https-port` picks another port,
`tapline dev --stop` turns it off). By hand:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8081
EXPO_PACKAGER_PROXY_URL=https://<computer>.<tailnet>.ts.net:8443 npx expo start --dev-client --port 8081
```

In the development build, tap **Enter URL manually** and enter
`https://<computer>.<tailnet>.ts.net:8443` (or open
`exp+<slug>://expo-development-client/?url=<that URL, encoded>`). `tailscale serve --https=8443 off`
stops it. Tapline's own connection doesn't need this: it works over the Tailscale address as is.

**Pair.** Ask your agent to pair your phone (its `pair` tool needs your app's URL scheme,
the `scheme` in app.json). It shows a QR code, also saved as `~/.tapline/pair-<port>.png`.
Without an agent: `tapline pair --scheme <your scheme>` prints one in the terminal. With
Tailscale on, scan the code with the phone's camera, open the app, and tap **Connect**.
The code works once and expires after 10 minutes.

In the agent, `apps` lists the phone and `look` shows its screen. From now on the app
reconnects by itself whenever it's open, as long as the agent (the host) is running on
the same port. Keep the app open on screen while the agent works: iOS pauses an app soon
after you switch away or lock the phone, which drops the connection until you open it again. With several agents, ports go to whichever starts first; if a phone stops
connecting after a restart, pair it again, or give each agent a fixed port
(`tapline mcp --port 7211`).

**Unpair** a phone by opening `<your-scheme>://tapline/forget` on it (the agent's `pair`
answer shows the exact link). Pairing with another computer replaces the old pairing.

**Simulators and emulators** on the same computer can pair the same way (open the link with
`xcrun simctl openurl booted '<link>'`), or skip pairing:
`startTapline({ enabled: true, url: 'ws://127.0.0.1:7210/', token })`, with the token from
`tapline token` in a git-ignored env file.

## Troubleshooting

`tapline doctor` checks Node, Tailscale, the token, the ports, the Windows firewall rule
and Metro over https, and says how to fix what's missing.

| Symptom | Fix |
|---|---|
| the development build can't load the app ("App Transport Security") | serve Metro over `https` (step 4, away from your Wi-Fi) |
| the app disconnects when you switch apps or lock the phone | expected: iOS pauses apps in the background; it reconnects when you open it again |
| scanning the code doesn't open the app | the scheme passed to `pair` must be the app's `scheme`; the build must have Tapline turned on |
| the app opens a "not found" screen | Expo Router: add `app/+native-intent.ts` (step 3) |
| "pairing code has expired or was already used" | ask for a new code; each one works once, for 10 minutes |
| the app never connects | Tailscale on, on both; the host (or the agent) is running; Windows: the firewall rule above |
| it forgets the computer after a restart | install `expo-secure-store` and rebuild, or pass `storage` |
| "no longer accepts this phone" | the computer's token changed (`~/.tapline/token` deleted); pair again |
| a paired phone stopped connecting after agents restarted | its host came back on another port; pair again |
| the prompt warns the address is outside Tailscale | the link points somewhere other than your Tailscale or local network: cancel unless you know why |
| `No React roots recorded` | `register` isn't the first import of the entry file (Expo Router: use your own `index.js`, step 3) |
| `screenshot … unsupported` | install `react-native-view-shot`, then rebuild the app (it has native code) |
| an element isn't in `look` | it has no text, label, `testID` or handler (give it a `testID`), or it's hidden: tabs that aren't selected and screens covered by another are left out |
| the tab bar isn't in `look` | native tab bars (Expo Router's `NativeTabs`) are drawn by iOS, not React; switch tabs with `open_url` and the tab's route (`myapp://settings`) |
| `type` didn't change an input | inputs without `onChangeText` keep their native text; target the input by `id` (its `testID`) |

## Undo

Open the forget link on each phone, remove the `register` and `startTapline` lines (and
your custom `index.js` and `+native-intent.ts`), uninstall `@tapline/react-native`, remove
`EXPO_PUBLIC_TAPLINE_ENABLED`, delete `~/.tapline` on the computer, the firewall rule if
you added one, and the Tailscale Serve entry for Metro (`tailscale serve --https=8443 off`).
