# Setting Tapline up for a user

Do the work on the computer and in the app's code yourself. Ask the user only for what needs
their hands, their accounts or their decisions. The full guide is `docs/setup.md` in the
Tapline repository, and `docs/quickstart.md` is the short one; this is the order.

Each person uses their own computer, their own Wi-Fi and their own phone. Never set a phone
up to use someone else's computer or network.

## What is needed

- A computer with Node.js 20 or later and git (Windows, macOS or Linux).
- An iPhone, and the user's own Expo or React Native app, which they can build as a
  development build or a TestFlight build. Expo Go can't run it.
- The phone on the same Wi-Fi as the computer (or the computer on a cable to the same
  router). Tailscale is optional, only for a phone away from that Wi-Fi (not part of v1).

The token in `~/.tapline/token` is a secret. Never print it, and never put it in chat, a
commit or a file.

## Steps on the computer

1. Get Tapline, build it, and check the computer:
   ```sh
   git clone https://github.com/<owner>/tapline
   cd tapline
   npm install
   npm run build
   npm install -g ./packages/host
   tapline doctor
   ```
   Fix what `doctor` reports. If it finds no Wi-Fi or LAN address, ask the user to join
   the same Wi-Fi as the phone. Tailscale warnings can be ignored on the same Wi-Fi. On
   Windows the firewall rule it names needs an administrator prompt that the user approves.
2. Add the MCP server to the agent host (below).

## Steps in the user's app

1. Install the SDK: from the clone, `npm pack -w @tapline/react-native`, then install that
   file in the app. Also `expo-secure-store` (remembers the pairing) and, for screenshots,
   `react-native-view-shot`.
2. Make `import '@tapline/react-native/register';` the first line of the app's entry file.
   For Expo Router that means a new `index.js` (that line, then
   `import 'expo-router/entry';`) and `"main": "index.js"` in package.json. When this is
   wrong the element list comes back empty with "No React roots recorded".
3. Right after it:
   ```js
   import { startTapline } from '@tapline/react-native';
   startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });
   ```
   The build carries no address and no token.
4. Expo Router only: add `app/+native-intent.ts` that returns `null` for
   `isTaplineLink(path)`, or pairing links open a "not found" screen (`tapline info` prints
   the lines).
5. Set `EXPO_PUBLIC_TAPLINE_ENABLED=1` only in the profiles used for testing (development,
   TestFlight, `.env.local` for local Metro). Never in the store profile.
6. Suggest `testID`s on the controls you will test, and add them if the user agrees. You
   target them as `id`.
7. A new native dependency means a new app build. **Ask the user before starting a build or
   a TestFlight submission:** they cost build minutes and reach testers.

## Pair the phone, and prove the chain

1. Call `pair` with the app's URL scheme (`scheme` in app.json). Show the user the QR code
   (it is also saved as a picture; the answer gives the path). They scan it with the phone
   on the same Wi-Fi and tap Connect in the app. When they are using the phone itself, give them the link
   to tap.
2. `apps` should now list the app, and `look` should show its screen.

A paired phone connects by itself when the app is opened. `<scheme>://tapline/forget` on the
phone unpairs it.

## The MCP server, per host

The server is a stdio command:

```sh
tapline mcp
```

- `--screenshots file` saves pictures in `~/.tapline/shots` and answers with their path, for
  hosts and agents that shouldn't receive images (a lead agent that hands pictures to a
  small model).
- `--viewer remote` also opens the live view to your own devices on Tailscale;
  `--viewer off` turns it off.

**Claude Code**

```sh
claude mcp add tapline -- tapline mcp
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.tapline]
command = "tapline"
args = ["mcp"]
```

**Any other MCP client:** register the stdio command above under the name `tapline`.

Without the global install, the command is `node /path/to/tapline/packages/host/dist/cli.js`
in place of `tapline`.

## This skill, per host

```sh
tapline skill install                # for this user: ~/.claude/skills and ~/.agents/skills
tapline skill install --project .    # for one project: .claude/skills and .agents/skills
```

Claude Code reads `.claude/skills`; Codex and other agents read `.agents/skills`.

## The live view

The `viewer` tool gives a link the user opens in a browser on their computer. They can
watch, take over, and pause you. Give the link to the user only: it carries a key.

## When something doesn't work

Run `tapline doctor` first.

| Symptom | Fix |
|---|---|
| `apps` lists nothing, phone never paired | `pair` with the app's scheme; the user scans the code with the phone on the same Wi-Fi |
| `apps` lists nothing, phone was paired | the user opens the app with the phone on the same Wi-Fi; it connects within a few seconds |
| the phone can't connect, on Windows | the firewall: `tapline doctor` names the rule for ports 7210 to 7219 (it allows the local subnet and Tailscale) |
| the phone can't connect, on any computer | the phone and the computer are on different networks, or the Wi-Fi blocks devices from each other (guest networks do) |
| the list is empty, "No React roots recorded" | the `register` import isn't the first line of the entry file |
| a pairing link opens a "not found" screen | Expo Router: `app/+native-intent.ts` is missing |
| every call answers `in_background` | the app isn't in front: the user opens it again |
| `not_answering` | the app froze: try once more, then the user closes and opens the app |
| no screenshots | the app needs `react-native-view-shot`, and a new build after adding it |
| a development build doesn't load on the same Wi-Fi | start Metro on the computer (plain http works on the local network) and check both are on the same network |
| a development build doesn't load away from the computer's Wi-Fi (optional, not part of v1) | serve Metro over https in the tailnet: `tapline dev` |
