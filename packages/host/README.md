# @tapline/host

The computer side of [Tapline](../../README.md): the server your app's
`@tapline/react-native` connects to over Tailscale, an MCP server for agents, and a CLI.
Node.js 20 or later. Full setup: [docs/setup.md](../../docs/setup.md).

## CLI

| Command | |
|---|---|
| `tapline mcp` | the host plus an MCP server on stdio (what agents run) |
| `tapline host` | the host alone, logging connections and app logs (`--scheme` also prints a pairing QR code) |
| `tapline pair --scheme <s>` | a pairing link and QR code in the terminal |
| `tapline info` | this computer's name and address, and the code the app needs |
| `tapline doctor` | check Node, Tailscale, the token, ports, the Windows firewall and Metro over https |
| `tapline dev [-- <metro command>]` | serve Metro over https in your tailnet and run Metro with `EXPO_PACKAGER_PROXY_URL` set |
| `tapline replay <name>` | replay a recorded script without an agent (exit code 1 when a step fails) |
| `tapline token` | print the token (only to connect without pairing, e.g. a simulator) |

Options: `--port <n>` for a fixed port (or `TAPLINE_PORT`; otherwise 7210, moving up to
7219 when taken, so each agent's host gets its own); `--host <addr>[,<addr>…]` to listen
on other addresses; `--screenshots file` (or `TAPLINE_SCREENSHOTS=file`) makes `look` save
screenshots in `~/.tapline/shots` (newest 50 kept) and return the path instead of the image,
for agents that hand images to smaller models. `TAPLINE_HOME` moves the data directory
(default `~/.tapline`).

Claude Code: `claude mcp add tapline -- tapline mcp`. Other MCP clients: run `tapline mcp`
as a stdio server; it logs to stderr only.

## MCP tools

`pair`, `apps`, `select_app`, `look`, `press`, `long_press`, `type_text`, `scroll`,
`toggle`, `open_url`, `logs`, `reload`, `wait`. Targets: `{testID}`, `{label}`,
`{text, index?}`, `{ref}` or `{x, y}`. Every action returns the fresh element list (text,
no screenshot) unless `look: false`; `look` adds a screenshot (`width` in pixels, default
600; `screenshot: false` skips it).

- `pair {scheme}` returns a pairing link for this host (with the port it actually got),
  its QR code as an image, and the forget link; the QR code is also saved as
  `~/.tapline/pair-<port>.png`. A code works once, for 10 minutes.
- With several apps connected, the latest one is used until `select_app` picks another.
  Phones that send no name (iPhones) show their install id.
- If an app can't take screenshots, the host remembers it for that session and stops asking.
- `reload` waits for the app to reconnect, then returns the element list.
- `logs` returns what the host has buffered since the app connected (500 lines); with
  nothing buffered it asks the app for its own.

## Security

- The token (32 random hex characters) is created on the first run in `~/.tapline/token`
  (`%USERPROFILE%\.tapline\token` on Windows). Treat it like a password. Pairing hands it
  to the app, which keeps it in the keychain; the MCP server never shows it to the agent.
  Delete the file to make a new one: every phone then has to pair again.
- Pairing codes are signed with the token, expire after 10 minutes, and each host accepts
  a code once.
- The host listens on your Tailscale address and 127.0.0.1 only. If one of them can't be
  used it keeps the other; without Tailscale, 127.0.0.1 only. `--host 0.0.0.0` opens it to
  your whole network: only on networks you trust.
- Connections without the right token are closed (4001), and bad pairing codes too
  (4004). Traffic is plain WebSocket inside Tailscale's encrypted tunnel.

## Develop

```sh
npm run typecheck && npm run build && npm test
```
