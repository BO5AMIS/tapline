# Tapline protocol (version 1)

Tapline lets an agent on your computer see and drive **your own app** on a phone,
from anywhere, over Tailscale (or any network that reaches the computer). The app
carries a small in-app agent (`react-native-tapline`); the computer runs the host
(`tapline-host`), which agents use through MCP or the CLI.

```
 phone (anywhere)                                  computer (home)
 ┌───────────────────────┐   WebSocket over        ┌──────────────────────────┐
 │ your app (dev build / │   Tailscale             │ tapline host             │
 │ TestFlight)           │ ──────────────────────▶ │  ws server  :7210-7219   │
 │  react-native-tapline│ ◀── requests ────────── │  MCP server (stdio)  ◀── agent (Claude …)
 └───────────────────────┘ ─── responses/events ─▶ │  CLI                     │
                                                    └──────────────────────────┘
```

The **app connects to the host**, never the other way: the phone needs no open
port, and it works on cellular as long as the phone can reach the computer.

## Transport

- WebSocket, `ws://HOST:PORT/` (default port **7210**; without an explicit port, a host
  whose port is taken moves up to 7219, so each agent's host gets its own). Text frames,
  one JSON object per frame, UTF-8.
- The host listens on its Tailscale address (and 127.0.0.1) by default, not on every
  interface.
- Authentication: a **token** (32 random hex chars) the host generates once and stores
  (`~/.tapline/token`). A paired app sends it in its first message. An app that is
  pairing sends a one-time **pairing code** instead (see [Pairing](#pairing)), and the
  host answers with the token. A wrong or missing token: the host closes with code
  **4001**. An invalid, expired or already used pairing code: **4004**. A message before
  `hello` (or no `hello` within 10 s): 4002. Unsupported protocol version: 4003. The host
  also closes with 4010 when the same app on the same device connects again (the new
  connection replaces the old one and keeps its log buffer; "same" means equal `app.id`,
  `device.platform` and `device.id`, else `device.name`, else `device.model`) and 4011
  when the app has been silent for 45 s.
- Either side may send `{"type":"ping"}`; the other answers `{"type":"pong"}`. The
  app pings every 15 s; the host drops an app silent for 45 s, and the app reconnects
  when the host has been silent for 45 s.
- The app handles requests one at a time, in order; the host gives each 15 s by default
  before failing it with `timeout` (the app's own limit is 30 s).
- The app reconnects with backoff (1, 2, 4 … 30 s) after any disconnect.

## Messages

### App → host: `hello` (first message)

```json
{
  "type": "hello",
  "protocol": 1,
  "token": "…",
  "app": { "name": "My App", "id": "com.example.myapp", "version": "1.2.0", "build": "45" },
  "device": { "platform": "ios", "osVersion": "26.1", "id": "3fa2c9d1e5b7" },
  "capabilities": ["tree", "press", "longPress", "type", "scroll", "toggle", "screenshot", "openURL", "logs", "reload"]
}
```

One of `token` and `pairCode` (with both, the host checks `pairCode`). `device.id` is a random id the app makes once per
install and keeps; it tells apart phones that send no `name` or `model` (iOS sends
neither). Android may also send `model`.

`app.id` is the app's own id, never its container's (AGENT-TOOLS 1.13 §18.9): what the app passes to
`startTapline`, else, from the app's config (`expo-constants`), `expoConfig.ios.bundleIdentifier ??
expoConfig.android.package ?? expoConfig.slug`, so an app in Expo Go has its own id and not Expo Go's. `app.build` is
`<version> (<build number>)`, the native version and build number (`CFBundleShortVersionString (CFBundleVersion)`);
in Expo Go, whose own build isn't the app's, the config's version and build number. A JavaScript reload is not a new build.

Optional capabilities added in 1.6 (a host checks for them and does without when they're absent):
`place` (the `place` request and event, and `tree.place`), `places` (the `places` request) and `move` (the
`move` request) and `waitOnce` (`waitFor` with `once`, below). A host without it reads one `tree` instead.
`pressFacts` (the `handler` and `startedRequests` fields of a `press` or `longPress` result, below): a host without it
says a tap that changed nothing without a clause about the handler (AGENT-TOOLS 1.13 §3).

### Host → app: `welcome`

```json
{ "type": "welcome", "protocol": 1, "session": "s-7f3a" }
{ "type": "welcome", "protocol": 1, "session": "s-7f3a", "token": "…" }
```

The second form answers a `hello` with a pairing code: the app keeps the `token` and uses
it for every later connection.

### Host → app: `request`

```json
{ "type": "request", "id": 12, "method": "press", "params": { "target": { "testID": "login-button" } } }
```

### App → host: `response`

```json
{ "type": "response", "id": 12, "ok": true, "result": { … } }
{ "type": "response", "id": 12, "ok": false, "error": { "code": "not_found", "message": "No element matches testID \"login-button\"" } }
```

Error codes: `not_found`, `ambiguous`, `not_actionable`, `unsupported`, `bad_params`,
`timeout`, `stale` (only from `move`, when its guard doesn't hold), `internal`. The host adds its own codes for the
agent (`busy`, `paused`, `in_background`, `reconnecting`, `not_connected`; it also says `stale` for a ref);
they don't travel on this wire.
A `not_actionable` message starts with a reason word: `disabled`, `off_screen`, `covered`,
`under_tab_bar`, `behind_alert` or `no_action` (for example `covered: e47 … is covered by …`).
A `{x, y}` target where nothing takes the action is `not_actionable` with
`no_action: Nothing at (x, y) takes a touch.`, not `not_found`. An `ambiguous` error also carries `refs`, the refs of up to 5
candidates (valid in later requests); its `message` describes each one:

```json
{ "code": "ambiguous", "message": "3 elements match text \"Delete\": e7 button \"Delete\" …", "refs": ["e7", "e9", "e12"] }
```

`capabilities` in `hello` are honest (`screenshot` only when the app can take one,
`reload` only in development builds), but advisory: the host may still call a method,
and the app answers `unsupported`.

### App → host: `event`

```json
{ "type": "event", "event": "log", "data": { "level": "warn", "message": "…", "ts": 1794115000123 } }
{ "type": "event", "event": "error", "data": { "message": "…", "stack": "…", "fatal": false, "ts": … } }
```

The app buffers the last 500 log lines (console.log/info/warn/error) and JS errors,
sends them as events while connected, and returns them from `logs`.

## Pairing

The app's build carries no address and no token. A phone pairs with a computer by
opening a pairing link (usually by scanning its QR code with the camera):

```
<scheme>://tapline/pair?url=ws%3A%2F%2F100.64.0.1%3A7210%2F&code=mw7mp1v7-d918a84ec6c73cfb0727&name=My%20PC
<scheme>://tapline/forget
```

- `<scheme>` is the app's own URL scheme. `url` is where the host listens (with the port
  it actually got), `name` the computer's name, `code` a pairing code.
- A pairing code is `<expiry, epoch ms in base 36>-<the first 20 hex chars of
  HMAC-SHA256(token, "tapline-pair:" + expiry)>`. It expires 10 minutes after it was made.
  Any host with the same token can check it, so `tapline pair` makes valid codes without
  talking to the running host. Each host process accepts a code once; another Tapline host
  on the same computer (another port), or the same host after a restart, could still accept
  it within its 10 minutes.
- The app asks the user before connecting ("Connect for testing?", naming the computer and
  its address, with a warning when the address is outside Tailscale and private networks),
  then sends `hello` with `pairCode`. The host answers `welcome` with its token; the app
  stores the URL (with its port), token and name (by default in `expo-secure-store`) and
  reconnects there with the token from then on. A new pairing link replaces the old
  pairing. Links with user info in `url` (`ws://a@b/`) are refused.
- On 4004 the app stops, tells the user the code expired or was used, and goes back to
  the computer it was paired with before, if any. On 4001 during the handshake (the
  computer's token changed) it stops and asks the user to pair again.
- The forget link makes the app disconnect and delete the stored pairing.
- The app does none of this unless its `startTapline` call has `enabled: true`.

## Targets

Most methods take a `target`, exactly one of:

| target | matches |
|---|---|
| `{ "ref": "e12" }` | element `e12` from the latest `tree` result |
| `{ "testID": "login-button" }` | `testID` prop, exact |
| `{ "label": "Log in" }` | `accessibilityLabel` / `aria-label`, case-insensitive exact |
| `{ "text": "Log in" }` | visible text, case-insensitive; exact match preferred, else substring |
| `{ "x": 120, "y": 640 }` | the frontmost actionable element whose frame contains the point (points, window coordinates) |

When several elements match, the frontmost visible one wins for `x,y`; for the others
the response is `ambiguous` with up to 5 candidate `refs`, unless `index` is given
(`{ "text": "Delete", "index": 1 }`, 0-based in tree order). `index` works with `testID`,
`label` and `text` targets. The host's agent-facing names differ: `id` for `testID`
(`testID` stays on the wire).

## Methods

### `tree` → the screen as elements

params: `{ "all": false, "changes": false }` (`all`: include elements without text, label,
testID or an action; `changes`: see below)

result:
```json
{
  "screen": { "width": 402, "height": 874, "scale": 3 },
  "route": { "names": ["(tabs)", "nutrition"], "params": { "day": "2026-11-09" } },
  "elements": [
    {
      "ref": "e3",
      "type": "Pressable",
      "role": "button",
      "testID": "login-button",
      "label": "Log in",
      "text": "Log in",
      "value": null,
      "frame": { "x": 24, "y": 610, "width": 354, "height": 48 },
      "actions": ["press", "longPress"],
      "disabled": false,
      "selected": false,
      "checked": null
    }
  ]
}
```

- `elements` are in tree (document) order. `frame` is in points, window coordinates
  (`measureInWindow`); elements with zero size or entirely off screen are omitted
  unless `all`.
- `type`: the nearest named React component that owns the element (`Pressable`,
  `Button`, `TextInput`, `Switch`, `ScrollView`, `FlatList`, `Text`, or the app's own
  component name when available).
- `actions`: from the props found on the element or its nearest owners:
  `press` (onPress), `longPress` (onLongPress), `type` (TextInput), `toggle`
  (onValueChange on Switch), `scroll` (ScrollView / FlatList / SectionList),
  `submit` (onSubmitEditing).
- `text`: the concatenated text of the element's `Text` descendants, trimmed, max 200 chars.
- `value`: a text field's current text; `null` otherwise. A switch reports its state in
  `checked` (true/false), not `value`.
- Hidden content is left out: subtrees hidden from accessibility (`aria-hidden`,
  `accessibilityElementsHidden`, `importantForAccessibility: "no-hide-descendants"`, which
  React Native Screens and React Navigation set on covered and unfocused screens), `display:
  none`, inactive screens (`RNSScreen` `activityState` 0) and tabs that aren't selected.
- Native tab bars (React Native Screens' tabs, used by Expo Router's `NativeTabs`): every tab
  is an element with `type` `"Tab"`, `role` `"tab"`, its title as `text`, `selected`, no
  `frame` and the `press` action, which switches tabs through the tab navigator.
- `route` (only in apps using React Navigation, Expo Router included): the focused screen's
  route names from the outermost navigator in, and its simple params (strings, numbers,
  booleans, null).
- `place` (1.6, capability `place`): where the app is, as a route key (see `place` below): `{ "route": ["(tabs)",
  "settings"], "tab": "settings", "layer": "sheet:Filters" }`. Always present; `route` is `[]` without a router.
- `row` (1.6): `true` on an element inside a virtualized list's item (React Native's cell renderer, FlashList's cell
  container). Its text is content, so a host never saves what a row said (AGENT-TOOLS 1.13 §18.2).
- `changes: true` asks for the difference from the previous `tree` call (on this
  connection). Refs of elements still on screen are kept, new ones get new numbers, and the
  result adds `"changes": { "sameRoute": true, "added": ["e58"], "removed": [<element as it
  was>], "changed": [{ "ref": "e12", "was": { "value": "" } }], "moved": ["e4"] }`. Without a
  previous call, or without `changes`, refs start at `e1` and there is no `changes`.

### `screenshot`

params: `{ "format": "jpg", "quality": 0.7, "maxWidth": 600 }` → result:
`{ "mime": "image/jpeg", "data": "<base64>", "width": 600, "height": 1304 }` (height
follows the screen's aspect; `width` and `height` are the image's pixels, never more than the
screen's own). On iOS, `react-native-view-shot` takes the size in points and renders at the
screen's scale, so the app divides by the scale there.
Needs `react-native-view-shot` in the app; otherwise error `unsupported`.

### `press` / `longPress`

params: `{ "target": …, "force": false }` → result: `{ "element": <element>, "settledMs": 310 }`
(the host's `tap` calls `press`). `settledMs`: every action result has it. The app answers
once React hasn't committed for 100 ms, 2 s at most, and reports how long that took. Calls the
target's `onPress` / `onLongPress` with a synthetic press event (`nativeEvent` with
`locationX/Y`, `pageX/Y`, `timestamp`; `persist()`, `preventDefault()`,
`stopPropagation()` no-ops). A disabled element: `not_actionable`.

With `pressFacts`, the result also says what the touch did (AGENT-TOOLS 1.13 §3; not on a dry run):
`"handler": { "kind": "own" }` when the touched element's own handler took it, `{ "kind": "own", "threw": "<message>" }`
when that handler threw (the press still answers, the message is also logged as `[tapline] onPress threw: …`), and
`{ "kind": "parent", "element": <element> }` when the element has none and an ancestor's took the touch (`threw` may be there
too). `"startedRequests": 2` counts the requests that began during the action (a counter next to the in-flight one; dev-server
traffic excluded). The host turns these into the clause of the "tap that changed nothing" note.

Real-touch check (unless `force`): an element entirely off screen is `not_actionable` (`off_screen`). The action scrolls an
element into view itself (§16.2), so `off_screen` means no scroll can bring it on screen, and the message says so: it lies in
a part of the screen that nothing scrolls (behind a fixed bar, or outside every list), so look at the screen, then target
something else or report it (AGENT-TOOLS 1.13.1 item 3). Otherwise the app hit-tests the centre of the element's visible
part with Fabric's `findNodeAtPoint` (as React Native's element inspector does); when the
touch would land on something that is neither inside the element nor one of its ancestors,
it's `not_actionable` and the message names what covers it. An open React Native `Modal` is
hit-tested first, from its own content: it is its own window over the app, so the root's hit
test never reaches it, and everything behind it is covered. On an iPhone in portrait with
native tabs (and no modal open), the tab bar iOS draws is taken to be the 49 points above the
home-indicator inset (from `react-native-safe-area-context` when the app has it), its tabs
spread evenly: a `{x, y}` target there is the tab under it, and an element whose middle is
there is `not_actionable` (under the tab bar). When the hit test isn't
available (old architecture) or finds nothing, the press goes ahead. `toggle` does the same.

### `type`

params: `{ "target": …optional, "text": "hello", "replace": true, "submit": false }`.
Without `target`: the focused TextInput, else the only TextInput on screen.
`replace: false` appends to the current value. Calls `onChangeText(newText)` and
`onChange({ nativeEvent: { text } })`, updates the native view's text for uncontrolled
inputs, and with `submit` calls `onSubmitEditing` / `onEndEditing`.
`backspace: n` (a whole number) first deletes the last n characters (code points, so 😀 is
one) and then appends `text`, if any; it never replaces. The live viewer's backspace key
sends `{ "backspace": 1 }`.
→ result: `{ "element": <element>, "value": "hello" }`.

### `scroll`

params: `{ "target": …optional, "direction": "down", "amount": 400 }`,
`{ "target": …optional, "direction": "down", "fraction": 0.8 }` or
`{ "target": …optional, "to": "end" | "start" }`. `amount` in points (default: 80% of
the scroll view's height). `fraction` (0.1 to 1) is a share of the scroll view; it can't be
combined with `amount`. The host's `scroll.amount` is sent as `fraction`. `up`/`down` move the vertical offset and `left`/`right` the
horizontal one, whatever the list's orientation; `down` shows what is below. Without
`target`: the largest scroll view on screen.
→ result: `{ "element": <element>, "offset": { "x": 0, "y": 1210 }, "settledMs": 120 }`.

### `toggle`

params: `{ "target": …, "value": true | false | omitted (flip), "force": false }` → calls
`onValueChange`. → `{ "element", "value" }`.

### `openURL`

params: `{ "url": "myapp://settings" }` → `Linking.openURL`. → `{}`.

### `commands` / `command`

`commands` → `{ "commands": [ { "name": "language", "description": "…" } … ] }`, the app's
registered test commands (`registerTaplineCommand`) plus the built-in `appearance`
(`{ "scheme": "light" | "dark" | "system" }`, `Appearance.setColorScheme`).
`command` params: `{ "name": "language", "args": { "code": "ar" } }` → `{ "name", "result" }`
(the command's return value, JSON-safe, at most 4000 characters). Unknown name: `not_found`
(the message lists the names); a throwing command: `internal`; slower than 15 s: `timeout`.

### `waitFor`

params: `{ "text" | "testID" | "label": "…", "gone": false, "networkIdle": false,
"timeout": 10 }` (at least one of the four; `timeout` in seconds, at most 30). Polls every
250 ms until an element matches (text contains, case-insensitive; testID equal; label
equal, case-insensitive), or none does with `gone`, and, with `networkIdle`, no request is in
flight. → `{ "met": true, "waitedMs": 1240 }`, or error `timeout`.

`once: true` (1.6, capability `waitOnce`; AGENT-TOOLS 1.13 §9.1) makes it one read for the host's `if` and
`optional` steps: no poll, no timeout, the same matching (the whole element list counts, so an element below
the fold is there). → `{ "found": true }`: the condition holds (with `gone`, the element is gone).
`timeout` is still checked if given; `once` with `networkIdle` only reads the network once.

### Status in `tree`

- `alerts`: open alerts the app showed with `Alert.alert` / `Alert.prompt`, oldest first:
  `{ "kind": "alert", "title", "message", "buttons": [ { "text", "style" } ], "standIn" }`.
  While an OS alert (not the stand-in) is open, `press`, `longPress` and `toggle` answer
  `not_actionable` unless `force`.
- `network`: `{ "inFlight": 2 }` while requests (fetch / XMLHttpRequest) are running; absent
  otherwise. Failed requests (status 400 and up, network errors, timeouts) are added to the
  logs as `[network] GET https://host/path?… → 500`, with the query string removed.

### Event `appState`

The app sends `{ "type": "event", "event": "appState", "data": { "state": "background" } }`
when it goes to the background or comes back (`active`). The host logs it and, after the app
drops, tells the agent the app went to the background. The app keeps the screen awake while
connected (`expo-keep-awake`, when the app has it) and reconnects at once when it's back in
front.

### `feed` / `overlay` and event `frame` (the live viewer)

`feed` params: `{ "on": true, "quality": "balanced" }` (`sharp` 700 px, `balanced` 400 px,
`light` 240 px wide) → `{ "on", "quality", "stats" }`. While on, the app captures its window
when React commits a change (after 250 ms of quiet), every 350 ms for 1.2 s after each
action, and at least once a second, never two at once, and sends each frame as an event:

```json
{ "type": "event", "event": "frame", "data": { "seq": 12, "rev": 340, "capturedAt": 1794115000123, "captureMs": 38, "mime": "image/jpeg", "data": "<base64>", "width": 400, "height": 869 } }
```

`rev` counts React commits, so a frame and an overlay with the same `rev` match. `stats`:
`{ "frames", "avgCaptureMs", "maxCaptureMs", "observedFrames", "janky", "jankyWhileCapturing" }`,
where `janky` counts animation frames that came more than 50 ms after the one before.
`{ "on": false }` stops it; so does losing the connection. The host turns it on only while
someone watches. The app lists `feed` in its capabilities when it can take screenshots.

`overlay` params: `{}` → `{ "rev", "screen": { "width", "height" }, "elements": [ { "ref",
"type", "label", "id", "frame" } ] }`: the elements on screen for the viewer's boxes.
`ref` is the element's ref from the last `tree` if it had one, else `null`. Reading it
doesn't change refs.

### `back`

params: `{}` → calls `goBack()` on the focused screen's React Navigation `navigation`, like
the back button or swipe. → `{ "route": ["(tabs)", "detail"] }` (where it went back from).
`not_actionable` when `canGoBack()` is false; `unsupported` without React Navigation.

### `logs`

params: `{ "since": 1794115000000 }` → `{ "entries": [ { "level", "message", "ts" } … ] }`,
the entries with `ts` after `since` (epoch milliseconds; all of them without `since`).

### `reload`

Development builds only (`__DEV__`): `DevSettings.reload()`. Otherwise `unsupported`.

### `place` (request and event; capability `place`)

AGENT-TOOLS 1.13 §18.1 and §18.11. Where the app is, as a route key. Names are route *patterns*, never params; nothing from
the screen's text is in it.

```json
{ "route": ["(tabs)", "settings", "language"], "tab": "settings", "layer": "sheet:Filters", "seenAt": 1731500000000 }
```

- `route`: the focused screen's route names from the outermost navigator in, each split on `/` (so `trips/[id]` is
  `["trips", "[id]"]`). `[]` when the app has no router or no screen yet. `/user/123` and `/user/456` are one place.
- `tab`: the selected tab's route name (a tab navigator's selected route, else a native tab bar's selected tab by its
  key, never its title); absent when there are no tabs.
- `layer`: what lies on top. `alert` for an open alert; `modal:<name>` or `sheet:<name>` for a navigation route
  presented as a modal or sheet (`<name>` is its route name; `stackPresentation` `formSheet`, `pageSheet` and `sheet` are
  sheets); for a bare `Modal`, `modal:<testID of its root>` or just `modal`. Never text from the screen. Absent when
  nothing lies on top.
- `seenAt`: epoch milliseconds when it was read.

The request `place` (params `{}`) answers it now. The event `place` is sent once right after `welcome`, then whenever the
route, the tab or the layer changes (about 40 ms after the commit, one per burst, never on a repeat; an alert opening or
closing counts). It is not sent while the app is disconnected. The host keeps the latest and answers `GET /place`
from memory (§18.11).

### `places` (capability `places`)

params: `{}` → `{ "source": "expo-router" | "react-navigation" | "none", "places": [ { "route": [...], "link": "wayfare://trips/[id]", "params": ["id"] } ] }`.

The places the app's route tree lists, before any visit (AGENT-TOOLS 1.13 §18.1, "Known before any visit"). `params` are
names only. `link` is `<scheme>://<path>` with `[id]` where a param goes, from the app's own scheme (a custom scheme
beats an `https` prefix); absent when the app has no scheme or the screen has no path. Expo Router's route tree is read
from its internal API behind a guard: any failure answers `source: "none"`. Supported: Expo Router 58, whose route tree
is `routerConfig.routeNode`, the value of the `RouterConfigContext` provider (read through the fibers); and Expo Router 55,
whose store (`expo-router/build/global-state/router-store.js`, with the `.js`) has `routeNode`. Other versions may answer
`none`, and then the `linking` route below is tried. React Navigation's comes from the
`linking` prop of the `NavigationContainer`, found through the fibers. Never throws.

### `move` (capability `move`)

AGENT-TOOLS 1.13 §18.4 (F7). Act, then wait until the next move's target is ready, in one request. The host checks its
policy and confirmation against what comes back before it sends the next move, so the app never decides what a person must
OK, and a move never navigates by itself: it is the ordinary `press`, `longPress`, `toggle`, `back`, `openURL` or
`swipe`.

params:
```json
{ "method": "press", "params": { "target": { "testID": "language-row" } },
  "guard": { "id": "language-row", "label": "Language", "text": "Language" },
  "next": { "target": { "testID": "language-list" }, "capMs": 1500 } }
```

- `method` and `params`: exactly what the plain method takes (`dryRun` passes through; nothing is waited for then).
- `guard` (optional): the host's policy check was made against this element. Before acting, the `target` is resolved again;
  if its `id`, `label` or `text` is not what the guard says, nothing is done and the answer is `stale`. Only for
  methods with a `target`.
- `next` (optional): wait up to `capMs` (at most 10 000) until this target is on screen, steady (the same frame on two
  looks 40 ms apart) and touchable (the `press` dry run's checks pass; a switch is looked at with a `toggle` dry run). A
  target below the fold that a scroll reaches counts as on screen.

result:
```json
{ "done": { "element": { … }, "settledMs": 120 },
  "place": { "route": ["(tabs)", "settings", "language"] },
  "next": { "state": "ready", "element": { … }, "waitedMs": 80 } }
```

- `done`: what the plain method returns, settle fields included.
- `place`: the place after the move (`null` only when it can't be read).
- `next.state`: `ready`; `missing` (not there at the cap, or refused for another reason); `covered` (covered by something,
  under the tab bar or behind an alert); `moving` (there but its frame still changing at the cap, with `element`).
  `element` is present for `ready` and `moving`. `waitedMs` is how long the wait took.
