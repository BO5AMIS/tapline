# Setting Tapline up for a user

Do the work on the computer and in the app's code yourself. Ask the user only for what needs
their hands, their accounts or their decisions. The full guide is `docs/setup.md` in the
Tapline repository, and `docs/quickstart.md` is the short one; this is the order.

Each person uses their own computer, their own Wi-Fi and their own phone. Never set a phone
up to use someone else's computer or network.

## What is needed

- A computer with Node.js 20 or later and git (Windows, macOS or Linux).
- An iPhone, and the user's own Expo or React Native app: a development build, a
  TestFlight build, or an Expo app in Expo Go (see "In Expo Go" below).
- The phone on the same Wi-Fi as the computer (or the computer on a cable to the same
  router). Tailscale is optional, only for a phone away from that Wi-Fi (not part of v1).

The token in `~/.tapline/token` is a secret. Never print it, and never put it in chat, a
commit or a file.

## Steps on the computer

1. Install Tapline and check the computer:
   ```sh
   npm install -g tapline-host
   tapline doctor
   ```
   (From a clone instead: `git clone https://github.com/bo5amis/tapline`, `npm install`,
   `npm run build`, `npm install -g ./packages/host`.)
   Fix what `doctor` reports. If it finds no Wi-Fi or LAN address, ask the user to join
   the same Wi-Fi as the phone. Tailscale warnings can be ignored on the same Wi-Fi. On
   Windows the firewall rule it names needs an administrator prompt that the user approves.
2. Add the MCP server to the agent host (below).

## Steps in the user's app

**Start with `init`.** In the app's folder run `npx tapline-host init`. It installs the three
packages and sets up the entry file (`register` and `startTapline`; for Expo Router its own
`index.js`), `metro.config.js` with `withTapline`, `app/+native-intent.ts` for Expo Router and
`.env.local`. `--dry-run` shows the changes without making them, `--no-install` skips the
install, `--project <dir>` picks the folder. Where a file is too custom, it gives exact advice:
follow it. It warns if the production profile turns Tapline on: fix that. A second run changes
nothing. Do the numbered steps below by hand only for what `init` could not do.

1. Install the SDK: `npx expo install react-native-tapline expo-secure-store
   react-native-view-shot` (the second remembers the pairing; the third takes screenshots).
2. Make `import 'react-native-tapline/register';` the first line of the app's entry file.
   For Expo Router that means a new `index.js` (that line, then
   `import 'expo-router/entry';`) and `"main": "index.js"` in package.json. When this is
   wrong the element list comes back empty with "No React roots recorded".
3. Right after it:
   ```js
   import { startTapline } from 'react-native-tapline';
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

1. A development build whose JavaScript comes from this computer's Metro: call `pair` with no
   scheme. It opens an offer for 10 minutes (one use, local network only). The app finds it by
   itself through Metro (needs `withTapline` in `metro.config.js`) or the host's port, and asks
   "Connect for testing?". The user taps Connect. No QR code is needed.
2. A TestFlight or release build, or when step 1 does not work: call `pair` with the app's URL
   scheme (`scheme` in app.json). Show the user the QR code
   (it is also saved as a picture; the answer gives the path). They scan it with the phone
   on the same Wi-Fi and tap Connect in the app. When they are using the phone itself, give them the link
   to tap.
3. `apps` should now list the app, and `look` should show its screen.

The Connect prompt is the person's consent. On a test phone that another agent (Tapwright)
also drives, that agent can accept it, so use pairing without a QR code only on the user's own
test phones and Wi-Fi.

A paired phone connects by itself when the app is opened. `<scheme>://tapline/forget` on the
phone unpairs it; deleting and reinstalling the app (or Expo Go) doesn't, because iOS keeps the
keychain.

**In Expo Go:** call `pair` with the address Expo prints instead of a scheme
(`exp://<computer's address>:8081`). The link opens the app in Expo Go and pairs in one step.
Expo Go has no Tapline native module, so the live view runs at about 6 frames a second (15 in
a development build) and iOS's own alerts aren't seen from inside the app. Current Expo Go
opens a project only when both Expo Go and the Expo CLI are signed in to an Expo account:
that is the user's step, never yours. On a first load, Expo Go's developer-menu intro can open
by itself: tap Continue, then close it. The **Connect for testing?** prompt is a system alert:
the user taps Connect (or, with Tapwright connected, its `alert` tool answers it).

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
- `--policy FILE` sets the words that need a person's OK or are blocked (JSON, per app);
  `--no-policy` turns the policy off, only for a test phone with test data. `--no-log` turns
  off the action log in `~/.tapline/log/`.
- Grants (1.7) are in the policy file, version 2: a person's standing OK for a touch, with limits. A covered touch
  answers `Note: allowed by grant "name" (2 of 3 today).` and asks no one; you never create, change or revoke one (only
  the person does). For the person, in a terminal: `tapline grants --policy FILE` (the grants, today's counts, the last
  uses), `tapline grants --policy FILE --revoke-all` (the kill switch), `tapline audit-log [--since <date>]` and
  `--delete`, and `tapline doctor --policy FILE` (a refused grant, a broken state file).
- `--no-dialog` keeps a person's OK to the live view (the host's own dialog is off), for a host that
  hands dialogs to the model instead of a person. `--brief` makes actions answer briefly.
  `--accounts FILE` loads the vault: test accounts, cards, addresses, identities, notes (a plain file outside any git
  repository, or ignored by it, for test data only; `tapline vault protect FILE` encrypts it; never print
  it). `--maps DIR` keeps each app's map in `DIR/<app id>/`. `tapline host` takes the same options
  and serves `tapline call`.

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
| the app doesn't ask to connect after `pair` with no scheme | the offer lasts 10 minutes: call `pair` again. `metro.config.js` needs `withTapline`; same Wi-Fi; the code must load from this computer's Metro, not a tunnel. TestFlight and release builds need the QR code |
| `not_allowed: needs_confirmation` | a policy word (Buy, Delete, Send …) is on the element: the user allows it in the host's dialog or the live view (`viewer`); with no dialog, repeat the call within 120 s after they have. Use `--no-policy` only on a test phone, with the user's OK |
| the list is empty, "No React roots recorded" | the `register` import isn't the first line of the entry file |
| a pairing link opens a "not found" screen | Expo Router: `app/+native-intent.ts` is missing |
| every call answers `in_background` | the app isn't in front: the user opens it again |
| `not_answering` | the app froze: try once more, then the user closes and opens the app |
| no screenshots | the app needs `react-native-view-shot`, and a new build after adding it |
| a development build doesn't load on the same Wi-Fi | start Metro on the computer (plain http works on the local network) and check both are on the same network |
| a development build doesn't load away from the computer's Wi-Fi (optional, not part of v1) | serve Metro over https in the tailnet: `tapline dev` |
