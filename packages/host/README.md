# @tapline/host

The computer side of [Tapline](../../README.md): the server your app's
`@tapline/react-native` connects to over the same Wi-Fi, an MCP server for agents, and a CLI.
Node.js 20 or later. Full setup: [docs/setup.md](../../docs/setup.md).

## CLI

| Command | |
|---|---|
| `tapline mcp` | the host plus an MCP server on stdio (what agents run) |
| `tapline host` | the host alone, logging connections and app logs (`--scheme` also prints a pairing QR code) |
| `tapline pair --scheme <s>` | a pairing link and QR code in the terminal |
| `tapline info` | this computer's name and address, and the code the app needs |
| `tapline doctor` | check Node, this computer's Wi-Fi or LAN address, the token, ports and the Windows firewall (Tailscale and Metro over https are optional: warnings only) |
| `tapline dev [-- <metro command>]` | optional, for a phone away from this Wi-Fi: serve Metro over https in your tailnet and run Metro with `EXPO_PACKAGER_PROXY_URL` set |
| `tapline replay <name>` | replay a recorded script without an agent (exit code 1 when a step fails) |
| `tapline token` | print the token (only to connect without pairing, e.g. a simulator) |
| `tapline skill install` / `skill path` | install the agent skill for Claude Code, Codex and other agents / print where it is |

Options: `--port <n>` for a fixed port (or `TAPLINE_PORT`; otherwise 7210, moving up to
7219 when taken, so each agent's host gets its own); `--host <addr>[,<addr>…]` to listen
on other addresses; `--screenshots file` (or `TAPLINE_SCREENSHOTS=file`) makes `look` save
screenshots in `~/.tapline/shots` (newest 50 kept) and return the path instead of the image,
for agents that hand images to smaller models; `--viewer <local|remote|off>` (or
`TAPLINE_VIEWER`) sets where the live viewer opens: this computer only (default), also your
own devices on Tailscale, or nowhere. `TAPLINE_HOME` moves the data directory (default
`~/.tapline`).

Claude Code: `claude mcp add tapline -- tapline mcp`. Other MCP clients: run `tapline mcp`
as a stdio server; it logs to stderr only.

## MCP tools

`pair`, `apps`, `open_app`, `look`, `check_layout`, `tap`, `long_press`, `type_text`,
`scroll`, `swipe`, `toggle`, `open_url`, `back`, `app_command`, `wait_for`, `record`, `replay`,
`compare_screen`, `filmstrip`, `viewer`, `logs`, `reload`, `wait`. Targets: `{ref}`, `{id}`
(the `testID` prop), `{label}`, `{text}` or `{x, y}`; `index` goes with `id`, `label` and
`text`. Every action answers with the verb and the element, then `Same screen. Changes:`
(or the full list when the screen changed), then `Settled in N s.`, then any `Note:` lines;
`look: false` returns only the first line. No image is sent by default: `screenshot: true`
on any action or on `look` adds one (`width` in pixels, default 600). Errors read
`Error <code>: <message>`; a `not_actionable` message starts with its reason (`disabled`,
`off_screen`, `covered`, `under_tab_bar`, `behind_alert`, `no_action`). After a person acts
in the live viewer, `{ref}` targets fail with `stale` until the next `look`. `scroll.amount`
is a share of the scroll area (0.1 to 1, default 0.8); `long_press` takes `seconds`, which
Tapline ignores.

- `pair {scheme}` returns a pairing link for this host (with the port it actually got),
  its QR code as an image, and the forget link; the QR code is also saved as
  `~/.tapline/pair-<port>.png`. A code works once, for 10 minutes.
- With several apps connected, the latest one is used until `open_app {app}` picks another (`app` is a session id, app
  id or name; several matches give `ambiguous`).
  Phones that send no name (iPhones) show their install id.
- If an app can't take screenshots, the host remembers it for that session and stops asking.
- `reload` waits for the app to reconnect, then returns the element list.
- `logs` returns what the host has buffered since the app connected (500 lines); with
  nothing buffered it asks the app for its own.
- `viewer` returns the live viewer's link, plus the app's capture and stutter numbers while
  someone watches. The viewer rides on the host's port (`/viewer`, `/stream`, `/ws`) and
  speaks [docs/VIEWER-PROTOCOL.md](../../docs/VIEWER-PROTOCOL.md). The app captures frames
  only while someone watches. A person's input goes ahead of the agent's actions, which
  wait until the person has been idle for 3 s (`busy` after 30 s; `paused` while paused).

## Security

- The token (32 random hex characters) is created on the first run in `~/.tapline/token`
  (`%USERPROFILE%\.tapline\token` on Windows). Treat it like a password. Pairing hands it
  to the app, which keeps it in the keychain; the MCP server never shows it to the agent.
  Delete the file to make a new one: every phone then has to pair again.
- Pairing codes are signed with the token, expire after 10 minutes, and each host accepts
  a code once.
- The host listens on this computer's Wi-Fi or LAN address (private addresses on real
  adapters only), on its Tailscale address when there is one, and on 127.0.0.1. Phones pair
  with the Wi-Fi or LAN address. `--host <addr>` chooses other addresses.
- Connections without the right token are closed (4001), and bad pairing codes too
  (4004). Traffic is plain WebSocket: use a Wi-Fi you trust (Tailscale, when used, encrypts it).
- The live viewer has its own random key, new on each start, in the link the `viewer` tool
  gives. Only that first page load takes the key in the address: it sets an HttpOnly,
  SameSite=Strict cookie and the page removes the key from the address bar. The stream and
  the WebSocket take the cookie or an `Authorization: Bearer` header, never the key in the
  URL. A cookie sent from another site (even another port on this computer:
  `Sec-Fetch-Site`) is refused, so are requests from another Host or (for the WebSocket)
  another Origin, and by default only this computer can open it.

## Develop

```sh
npm run typecheck && npm run build && npm test
```
