# Setup

About fifteen minutes: your computer once, each app once, then a QR code per phone. The
computer side takes about two minutes (measured from a clean copy: install 40 s, build 10 s,
checks a few seconds). The app side needs one new app build, and how long that takes is up to
your build system, not Tapline.

Short version: [quickstart.md](quickstart.md).

Everyone who tests sets this up for themselves: their own computer, their own Wi-Fi,
their own phone and their own agents. Nobody needs anyone else's computer, and the app
build is the same for everyone.

## 1. The network

The test phone stays next to the computer, on the same Wi-Fi (or the computer is on a cable
to the same router). That is all the network setup v1 needs.

**Optional, to reach a phone away from this Wi-Fi (not part of v1):** install
[Tailscale](https://tailscale.com) on your computer and on your phone, signed in to your own
Tailscale network, and keep it on on the phone. The host then also listens on the Tailscale
address.

## 2. The computer (host)

Node.js 20 or later, and git.

```sh
npm install -g tapline-host        # puts `tapline` on your PATH
tapline doctor                     # about 5 s: checks the computer side
```

**From a clone instead** (to change Tapline, or to run it unreleased):

```sh
git clone https://github.com/bo5amis/tapline
cd tapline
npm install                        # about 30 s
npm run build                      # about 10 s
npm install -g ./packages/host
```

**QA and unattended runs use a pinned release, never a clone.** Install exactly one version,
`npm install -g tapline-host@<version>` on the computer and `react-native-tapline@<version>` in
the app. A clone in the middle of a change runs whatever is in its tree. `tapline doctor` warns
when the host it runs is loaded from a git work tree with uncommitted changes.

`npm install` in a clone ends with a few `deprecated` warnings and "low severity
vulnerabilities". They come from the test tools (Jest), not from anything Tapline ships; ignore them.
Or skip the global install and run `node /path/to/tapline/packages/host/dist/cli.js`
wherever this guide says `tapline`, for example
`node /path/to/tapline/packages/host/dist/cli.js doctor`.

**Give it to your agent.** The MCP server is the host: while the agent is running, your
phone can connect.

```sh
claude mcp add tapline -- tapline mcp           # Claude Code
# without the global install:
claude mcp add tapline -- node /path/to/tapline/packages/host/dist/cli.js mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.tapline]
command = "tapline"
args = ["mcp"]
```

**Give your agents the skill.** It tells an agent how to set Tapline up, read its answers,
test well and report:

```sh
tapline skill install                # for you: ~/.claude/skills and ~/.agents/skills
tapline skill install --project .    # for one project: .claude/skills and .agents/skills
```

Claude Code reads `.claude/skills` (ask for `/tapline`); Codex and other agents read
`.agents/skills` (in Codex, `$tapline`). Run it again after you update Tapline: it replaces
its own older copy and nothing else.

If your agent hands screenshots to smaller helper models, add `--screenshots file`: `look`
then returns a file path instead of the image ([AGENTS.md](../AGENTS.md#screenshots-and-tokens)).
The live viewer (the agent's `viewer` tool gives its link) opens on this computer only; add
`--viewer remote` to also open it from your own devices on Tailscale, or
`--viewer off`.
Other MCP clients: run `tapline mcp` as a stdio server. To only watch connections and
app logs, without an agent: `tapline host --scheme <your app's scheme>` (it also prints a
pairing QR code).

`tapline info` shows this computer's name and address, and the few lines the app needs
(step 3). A token is created on the first run and kept in `~/.tapline/token`
(`%USERPROFILE%\.tapline\token` on Windows). `info` never prints it, and you never copy it
anywhere: pairing hands it to the app.

The host listens on this computer's Wi-Fi/LAN address(es) (private IPv4 addresses on real
adapters, Wi-Fi first), on the Tailscale address if Tailscale runs, and on 127.0.0.1, on
port 7210. It gives the app the Wi-Fi address in the pairing link. When 7210 is taken
(another agent's host), it takes the next free port up to 7219, so several agents can run
at once, each with its own phone. Options: `--port` (or `TAPLINE_PORT`) for a fixed port,
`--host` (comma-separated addresses to listen on instead). If the computer has no Wi-Fi or
LAN address and no Tailscale, it listens on 127.0.0.1 only and says so: join the same
Wi-Fi as the phone. Traffic on the local network is plain WebSocket, so use a Wi-Fi you
trust.

**Windows:** the first time, Windows Firewall may ask whether Node.js may accept
connections. Allow it on **private** networks, and make sure your Wi-Fi is set to
private. Without that prompt, as admin:

```powershell
New-NetFirewallRule -DisplayName "Tapline" -Direction Inbound -Protocol TCP -LocalPort 7210-7219 -RemoteAddress LocalSubnet,100.64.0.0/10 -Action Allow
```

`LocalSubnet` is your Wi-Fi; `100.64.0.0/10` is Tailscale.

**Options for the agent's side (1.6).** `tapline mcp` and the standalone `tapline host` take these:

- `--brief`: actions answer in at most 12 element lines (a call's `brief: false` overrides it).
- `--accounts FILE`: the vault (AGENT-TOOLS 1.14 §20), so an agent can sign in and fill forms by name without
  seeing a value:
  `{"version": 2, "vault": {"tester2": {"kind": "account", "username": "...", "password": "...", "apps": ["com.example.wayfare"]}, "home": {"kind": "address", "street": "...", "city": "...", "postcode": "...", "country": "..."}, "visa": {"kind": "card", "number": "...", "expiry": "...", "cvc": "..."}}}`.
  Kinds: `account`, `card`, `address`, `identity`, `note`, and `phone` (Tapwright's; Tapline never types it).
  The agent refers to `${vault.home.street}` (the whole text of a step), or `account: "tester2"` with
  `${account.username}`. A card's fields are typed only with a person's OK each time. A version 1 file
  (`{"version": 1, "accounts": {...}}`) still loads.
  A plain file is for test data only: it must sit outside any git repository, or be ignored by it, or Tapline
  refuses it, and every start says it is not encrypted. `tapline vault protect FILE` rewrites it in this
  system's protected form (Windows DPAPI for the current user, or the macOS keychain; a protected file has no
  values in it, so it may sit anywhere, and Tapwright reads it too). Keep the file outside the folders the
  agent can read. A password stays out of pictures only while its field is secure.
  `tapline doctor --accounts FILE` checks it and prints the names and kinds, never the values.
- `--maps DIR`: keep each app's map (places, roads, links, routes, reflexes) in `DIR/<app id>/`
  instead of `~/.tapline/maps/<app id>/`. A team can share one folder.
- `tapline explore` (1.8) searches the app with no agent and writes a report: `tapline explore [--minutes N] [--steps N] [--depth N]
  [--from PLACE] [--focus PLACE] [--fill test-data] [--continue] [--account NAME]`, with `--policy`, `--accounts` and `--maps` as for
  the server. Exit 0: nothing found; 1: findings; 2: couldn't start, or a person or a pause stopped it. The app must be open on the phone.
  `tapline replay <name> --repair suggest|apply [--adopt]` mends a saved test after a rename or a move (`apply` writes
  `<name>.repaired.json` and `<name>.repair.md`; `--adopt` replaces the original, a person's choice).
- `tapline schedule` and `tapline run-schedule` (1.7) run a saved route with no agent, on a time or when a file
  appears. `tapline schedule add <route> --at "09:00 daily" [--with name=value|name=@file] [--name NAME]
  [--policy FILE] [--accounts FILE] [--maps DIR]` writes `~/.tapline/schedules/<name>.json` (the files are saved as
  absolute paths, and `@file` is read when the run starts, relative to that folder) and, on Windows, registers a Task
  Scheduler task that runs `tapline run-schedule <name>` (a time schedule sets `WakeToRun`, so it wakes the PC). `--on-file FOLDER` runs when a
  new file appears there (the task checks every minute and does not wake the PC). `tapline schedule list`, `tapline schedule remove NAME`, `tapline schedule unlock NAME`. The
  phone's app must be open and connected: a running `tapline host` is used only when it runs with the schedule's own policy, accounts and maps
  (the run asks it, and never drives through a host that differs); otherwise the run starts its own host with the schedule's
  policy, accounts and maps and waits `--wait` seconds (default 60) for the app, and skips if the app doesn't connect to it. Skips:
  `skipped: the phone was in use` (after waiting 10 minutes), `skipped: the previous run is still going`,
  `skipped: the app is not open`; a draft with no one to show it to ends `stopped: a draft is waiting for a person.`.
  Reports go to `~/.tapline/runs/`, lines to the audit log. Other systems: the schedule is saved; start it from cron or
  launchd with `tapline run-schedule <name>`.
  **Stuck locks.** A lock that is empty or unreadable (a run crashed mid-write where hard links are not available) is never taken over, so it blocks its schedule, or edits of the policy file, until a person removes it. `tapline doctor` (with `--policy FILE` for the policy edit lock) names each stuck lock with its full path and the command that removes it: `tapline schedule unlock NAME` or `tapline grants unlock --policy FILE`. Both remove the lock (and its `.takeover`) only when no live holder is proven, name the pid when there is one, and write an audit line.
$P
- `--no-dialog` (`mcp`): don't open the host's dialog for a person's OK or a "needs a person" moment;
  the live view still asks. Use it with a chat app that passes dialogs to the model instead of
  showing them to a person.

`tapline host` runs in the foreground with the live view and takes all the options of `mcp`. While
it runs, `tapline call <tool> '<json>'` sends one tool call to it in about 0.1 s (`--client NAME`
names the caller; `--json` prints `{"text", "image_path"}`; exit 0 an answer, 2 a refusal, 3 no host).
A phone pairs with that host, not with an agent's own MCP server.

## 3. The app

Your own React Native or Expo app, in a development build or a TestFlight build, or an Expo
app in Expo Go (see "In Expo Go" below).

**The quick way: `init`.** In the app's folder:

```sh
npx tapline-host init
```

It does the steps below for you:

- installs `react-native-tapline`, `expo-secure-store` and `react-native-view-shot`;
- sets up the entry file with `register` and `startTapline` (for Expo Router, its own `index.js`);
- adds `withTapline` to `metro.config.js`;
- adds `app/+native-intent.ts` for Expo Router;
- puts `EXPO_PUBLIC_TAPLINE_ENABLED=1` in `.env.local`.

`--dry-run` shows what it would change and changes nothing. `--no-install` skips the package
install. `--project <dir>` runs it for another folder. Where a file is too custom to edit,
it tells you exactly what to add by hand. It warns you if a production build profile turns
Tapline on. Run it a second time and it changes nothing. You still need a new build if a
native package was added, and you still decide which profiles turn Tapline on (see "Turn it
on only where you test" below).

**By hand:** the rest of this step does the same work, one piece at a time.

**Install the package:**

```sh
npx expo install react-native-tapline       # the SDK (or npm install react-native-tapline)
npx expo install expo-secure-store          # remembers the paired computer
npx expo install react-native-view-shot     # optional: screenshots
npx expo install expo-keep-awake            # optional: keeps the screen on while an agent is connected
```

All three have native code: a new development build or TestFlight build includes them.
Without `expo-secure-store`, pairing works but lasts only until the app restarts (or pass
your own `storage`, see below). Without `expo-keep-awake` the phone's screen can lock while
an agent works; it matters most for a dedicated test device.

From a clone of Tapline instead, `npm pack -w react-native-tapline` (after `npm run build`)
makes `react-native-tapline-1.0.0.tgz`; install that file in your app (Metro handles a tarball
better than a linked folder).

The package also carries a small Expo native module, which any new build of an Expo app picks
up by itself (no config plugin). With it, the live viewer runs at about 15 frames a second
instead of 6, and the agent sees an alert from native code or the share sheet over the app
(an `Alert:` line, with taps behind it refused). A build without it works as before.

**Load `register` first.** It has to run before React starts. The simplest way is Metro,
in `metro.config.js` (it only does this when `EXPO_PUBLIC_TAPLINE_ENABLED=1`, so store
builds are untouched):

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withTapline } = require('react-native-tapline/metro');

module.exports = withTapline(getDefaultConfig(__dirname));
```

`withTapline` does two things. It loads `register` before your app's code. It also lets Metro
answer a development build that asks for a pairing offer (see "Pairing a development build
without a QR code" below); that answer goes to the local network only. Without it, pairing a
development build without a QR code does not work.

Then call `startTapline` (below) anywhere that loads at startup, such as the top of
`app/_layout.tsx`. Or, without the Metro helper, import it on the first line of the app's
entry file:

- Expo Router (`"main": "expo-router/entry"` in package.json): create `index.js` and set
  `"main": "index.js"`:

  ```js
  import 'react-native-tapline/register';
  import 'expo-router/entry';
  ```

- Other Expo apps: the first line of `index.js`, above `registerRootComponent`.
- Bare React Native: the first line of `index.js`, above `AppRegistry.registerComponent`.

**Start it.** In the same file, after the `register` line:

```js
import { startTapline } from 'react-native-tapline';

startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });
```

That's all the build carries: an on switch. No address, no token. With the switch off,
`startTapline` does nothing at all. With it on, the app reconnects to the computer it was
paired with whenever it's open (a new try one second after each failed one while the computer can't be
reached), and pairs when a pairing link opens it. It never throws into the app.
`stopTapline()` shuts it down. Optional: `app: { name, id, version, build }` to name the
app in `apps`, and `storage` (`getItem`, `setItem`, `removeItem`, all async) to keep the
pairing somewhere other than `expo-secure-store`.

**Expo Router: let pairing links through.** Expo Router would open a "not found" screen
for a pairing link. Add `app/+native-intent.ts` (next to your other routes):

```ts
import { isTaplineLink } from 'react-native-tapline';

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
import { registerTaplineCommand } from 'react-native-tapline';

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

**A development build on the same Wi-Fi.** The build loads its JavaScript from Metro on
your computer over plain `http` on the local network: start Metro as usual
(`npx expo start --dev-client --port 8081`) and open the project from the development
build. Nothing more is needed.

**Optional, later: a development build away from your Wi-Fi (not part of v1).** The build
loads its JavaScript from Metro on your computer. iOS refuses plain `http` to a Tailscale
address ("App Transport Security
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
the phone on the same Wi-Fi, scan the code with the phone's camera and open the app. It asks **Connect for
testing?** and names the computer: tap **Connect**. The code works once and expires after 10
minutes. TestFlight and release builds always pair this way. A development build can also
pair without a QR code, as the next section shows.

### Pairing a development build without a QR code

Call `pair` with no scheme (or run `tapline pair`). Tapline opens an offer for 10 minutes. It
works once, and it is available on the local network only: never through Tailscale or the
internet.

A development build finds the offer by itself, when its JavaScript comes from this computer's
Metro. It asks Metro first, then the host's own port (7210 to 7219). Then it asks **Connect
for testing?** and names the computer: tap **Connect**.

What it needs:

- `withTapline` in `metro.config.js` (`init` adds it), and Metro running on this computer;
- the phone and the computer on the same Wi-Fi;
- the app open on the phone, within the 10 minutes.

The Connect prompt is the person's consent. On a test phone that another agent also drives
(for example Tapwright), that agent can accept the prompt. Use this only on test phones that
you control, on your own Wi-Fi. If you want a person to scan, pair with the scheme and the QR
code instead.

**In Expo Go.** An Expo app also runs Tapline in Expo Go, with no build: install the package
and the three Expo modules above (Expo Go carries them), set `EXPO_PUBLIC_TAPLINE_ENABLED=1` in
`.env.local`, and start Metro (`npx expo start --go`). To pair, give `pair` the address Expo
prints instead of a scheme: `tapline pair --scheme exp://<computer's address>:8081`, or ask your agent
to pair with that address. Scanning the code opens the app in Expo Go and pairs in one step.
Expo Go has no room for Tapline's native module, so the live view runs at about 6 frames a
second instead of 15, and iOS's own alerts and the share sheet aren't seen from inside the app.
Current Expo Go opens a project only when you're signed in to your Expo account both in Expo Go
and in the Expo CLI (`npx expo login`). On a first load, Expo Go's developer-menu intro may
open by itself: tap Continue and close it.

In the agent, `apps` lists the phone and `look` shows its screen. From now on the app
reconnects by itself whenever it's open, as long as the agent (the host) is running on
the same port. Keep the app open on screen while the agent works: iOS pauses an app soon
after you switch away or lock the phone, which drops the connection until you open it again.
With several agents, ports go to whichever starts first; if a phone stops connecting after a
restart, pair it again, or give each agent a fixed port (`tapline mcp --port 7211`).

**Unpair** a phone by opening `<your-scheme>://tapline/forget` on it (the agent's `pair`
answer shows the exact link). Pairing with another computer replaces the old pairing. Deleting
the app (or Expo Go) doesn't unpair it: iOS keeps the keychain, so a reinstalled app reconnects
by itself. Use the forget link.

**Simulators and emulators** on the same computer can pair the same way (open the link with
`xcrun simctl openurl booted '<link>'`), or skip pairing:
`startTapline({ enabled: true, url: 'ws://127.0.0.1:7210/', token })`, with the token from
`tapline token` in a git-ignored env file.

## Troubleshooting

`tapline doctor` checks Node, the Wi-Fi or LAN address, the token, the ports and the
Windows firewall rule, and says how to fix what's missing. It also checks Tailscale and
Metro over https, but those are optional warnings: you only need them for a phone away from
your Wi-Fi.

| Symptom | Fix |
|---|---|
| the development build can't load the app ("App Transport Security") | you are away from your Wi-Fi: serve Metro over `https` (step 4, optional, later). On the same Wi-Fi, check that the phone and the computer are on the same network |
| the app disconnects when you switch apps or lock the phone | expected: iOS pauses apps in the background; it reconnects when you open it again |
| the agent gets `not_connected` or `in_background` | the app isn't open in front: open it on the phone (on the same Wi-Fi); `apps` should list it |
| scanning the code doesn't open the app | the scheme passed to `pair` must be the app's `scheme`; the build must have Tapline turned on |
| the app doesn't ask to connect (pairing without a QR code) | the offer from `pair` lasts only 10 minutes and works once: call `pair` again. Check that `metro.config.js` uses `withTapline`, that the phone and the computer are on the same Wi-Fi, and that the app loads its code from Metro on this computer, not through a tunnel. TestFlight and release builds need the QR code (`pair` with the scheme) |
| `not_allowed: needs_confirmation` | the touch is on an element with a policy word (Buy, Delete, Send …). Choose Allow once in the dialog your MCP client shows or in the live view; the agent's call waits up to 120 seconds for it. If your client shows no dialog, or passes it to the model instead of a person, run the MCP server with `--no-dialog`; then allow in the live view and the agent repeats the call. On a test phone with test data, run the MCP server with `--no-policy` |
| the app opens a "not found" screen | Expo Router: add `app/+native-intent.ts` (step 3) |
| "pairing code has expired or was already used" | ask for a new code; each one works once, for 10 minutes |
| the app never connects | the phone and the computer are on the same Wi-Fi (some guest or office networks block devices from each other); the host (or the agent) is running; Windows: the firewall rule above |
| it forgets the computer after a restart | install `expo-secure-store` and rebuild, or pass `storage` |
| "no longer accepts this phone" | the computer's token changed (`~/.tapline/token` deleted); pair again |
| a paired phone stopped connecting after agents restarted | its host came back on another port; pair again |
| the prompt warns the address is outside your network | the link points somewhere other than your local network or Tailscale: cancel unless you know why |
| `No React roots recorded` | `register` isn't the first import of the entry file (Expo Router: use your own `index.js`, step 3) |
| `screenshot … unsupported` | install `react-native-view-shot`, then rebuild the app (it has native code) |
| an element isn't in `look` | it has no text, label, `testID` or handler (give it a `testID`), or it's hidden: tabs that aren't selected and screens covered by another are left out |
| a tab isn't in `look` | native tab bars (Expo Router's `NativeTabs`) are drawn by iOS: their tabs show as `tab` elements without a position, and tapping one switches tabs; screens of tabs that aren't selected are left out. `open_url` with the tab's route (`myapp://settings`) also works |
| `type_text` didn't change an input | inputs without `onChangeText` keep their native text; target the input by `id` (its `testID`) |
| the agent gets `not_answering` | the app is connected but stopped answering (a frozen screen, or its JavaScript is stuck): try once more, then close the app and open it again |
| the app shows a red "Metro has encountered an error: EMFILE" screen (Windows, development builds) | Metro ran out of open files while rebuilding after a file change, which happens in large projects on Windows; it isn't Tapline. Stop Metro, start it again, then close the app and open it (a cold start); avoid saving files Metro watches while a test runs |

## Undo

Open the forget link on each phone, remove the `register` and `startTapline` lines (and
your custom `index.js` and `+native-intent.ts`, and `withTapline` in `metro.config.js`), uninstall `react-native-tapline`, remove
`EXPO_PUBLIC_TAPLINE_ENABLED`, delete `~/.tapline` on the computer, the firewall rule if
you added one, and the Tailscale Serve entry for Metro (`tailscale serve --https=8443 off`).
