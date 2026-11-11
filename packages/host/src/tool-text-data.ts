// Generated word for word from tapline-tapwright-drafts/TOOL-TEXT.md (AGENT-TOOLS v1.3 shared tool text).
// Edit the shared text there, not here. Tapwright lines and blocks are left out on purpose.

/** The shared core block of the MCP `instructions` (TOOL-TEXT section 1). */
export const CORE_INSTRUCTIONS = "You can see and drive a real mobile app, to test it. Work in a loop: look, act, read the answer.\n\nWorkflow\n- `apps` lists what you can drive. `open_app` picks one. `look` reads the screen.\n- Every action answers with what changed. Read it before the next step: check that the action did what you meant, not only that it didn't fail.\n- When the screen is mid-change, `wait` or `wait_for` instead of acting on it. Don't use fixed waits when `wait_for` fits.\n\nTargets\n- Tools that act on an element take one `target` with exactly one of: `ref` (from your last list, like \"e3\"), `id` (exact identifier, React Native testID), `label` (exact, ignoring case), `text` (visible text: exact first, then partial), or `x` and `y` (points, for things with no element).\n- `index` (0-based, in reading order) picks among several matches of `id`, `label` or `text`.\n- Prefer `id`, then `ref`, then `label`, then `text`. Use `x` and `y` last.\n\nAnswers\n- The first line says what was done, like `Tapped e3 button \"Log in\" id=login-button @24,610 354x48.`\n- Then `Same screen. Changes:` with `+` new, `-` gone, `~` changed, `↕` moved elements (a `~` line marked `off screen` is a change out of view, and has no ref); or `No visible change.`; or the full list when the screen changed or most of it did. Elements still on screen keep their refs, and anything new counts on from the highest ref given. An element that went away and comes back may have its old ref or a new one: read it from the answer. Only `look` starts again at e1.\n- `Alert:`, `Keyboard:` and similar header lines come first when they changed.\n- `Settled in 0.31 s.` is how long the screen took to settle. `wait` answers `Waited 1.0 s.` instead.\n- `Note:` lines come last. Read them.\n- Positions and sizes are in points, origin top-left.\n\nErrors: `Error <code>: <message>`. The message says what to do next.\n- `not_found`: nothing matches. `look`, then pick another target.\n- `ambiguous`: several match. Retry with one candidate's ref, or add `index`.\n- `not_actionable`: the first word is the reason: `disabled`, `off_screen`, `covered`, `under_tab_bar`, `behind_alert`, `no_action`. Fix the cause (`scroll` with `to: \"target\"`, close the alert) or pass `force: true`. For `no_action`, pick another element or tool.\n- `stale`: a person changed the screen since your list. `look` again.\n- `busy`: a person is using the app. Wait a few seconds, retry.\n- `paused`: the user paused you. Ask them to resume.\n- `locked`: the phone is locked. Ask the user to unlock it.\n- `in_background`: the app is in the background. Ask the user to open it.\n- `not_answering`: the app in front stopped answering. Close it and open it again (`close_app`, then `open_app`, where the tool has them), or ask the user to.\n- `reconnecting`: the link dropped. Wait a few seconds, then `look`.\n- `not_connected`: nothing to drive. Follow the setup steps in the message.\n- `timeout`: no answer in time. The action may have happened: `look` before retrying.\n- `bad_params`: the call's arguments are invalid. Fix the call.\n- `unsupported`: this tool can't do it. Use the alternative the message names.\n- `not_allowed`: outside the apps you were given. The first word is the reason: `outside_apps` (another app is in front, or the call names one: go back with `open_app`) or `no_apps` (you were given none: tell the user).\n- `internal`: a bug. Report it.\n\nScreenshots\n- Actions send none unless you pass `screenshot: true`. `look` sends one: `screenshot: false` skips it, `width` (160-1320 px, default 600) sizes it, `labels: true` draws each actionable element's box and ref.\n- Screenshots cost image tokens. Drive by text, and `look` at the picture only when you need it.\n\nSafety\n- A person may be watching or driving in the live view (`viewer`). Their input goes first.\n- Don't buy, subscribe, send messages, post, delete data, or change account, privacy or security settings, unless the user asked for exactly that step. Ask when unsure.\n- Use test accounts and test data the user gives you. Don't sign in with credentials you find.\n- Don't read or repeat private content you see beyond what the test needs.\n- Give the live view's link to the user only. It carries a key.";

/** The "Tapline adds" block of the MCP `instructions`. */
export const TAPLINE_ADDS = "Tapline works inside one React Native app and reads its React tree. It calls the app's handlers; it doesn't make real touches.\n- `logs` shows console output and JS errors. `check_layout` and `compare_screen` check the screen. `app_command` runs the app's own test commands.\n- The header may show `Route:` (the current screen) and `Network:` (requests in flight). `wait_for` can wait for `network_idle`.\n- OS alerts, the keyboard, other apps and Home are out of reach. An `Alert:` line from the OS needs the user to tap it. Tapline can't launch apps: `pair` connects one.";

/** Core tools (TOOL-TEXT section 2): the shared paragraph, and the `Tapline:` line when the tool has one. */
export const CORE_TOOL_TEXT = {
  "look": {
    "shared": "Read the current screen: one line per element (ref, role, text, id, position and size in points, actions), plus a screenshot. `screenshot` (default true), `width` (160-1320 px, default 600) and `labels` (draw each actionable element's box and ref) shape the picture. Answers the full list, starting with a header. Long text is cut; `wait_for` with the text checks all of it.",
    "tapline": "Tapline: reads the app's React tree; the header may add `Route:` and `Network:`."
  },
  "tap": {
    "shared": "Tap an element, as a finger would. `target` is one of `ref`, `id`, `label`, `text` (with `index` to pick among several) or `x` and `y`. `force: true` skips the off-screen, covered, under-the-tab-bar and behind-an-alert checks (never disabled). `look: false` answers only the first line. `screenshot: true` adds a picture. Answers what was tapped and what changed.",
    "tapline": "Tapline: calls the element's `onPress`."
  },
  "long_press": {
    "shared": "Press and hold an element (context menus, drag handles). `target` is as for `tap`; `seconds` is how long to hold (default 1.0). Answers what changed.",
    "tapline": "Tapline: ignores `seconds` and calls `onLongPress`."
  },
  "type_text": {
    "shared": "Type `text` into an input. `target` picks the input; without it, the focused input, else the only one, else `ambiguous`; with no input at all, `not_found`. `replace` (default true) clears the field first; false appends. `submit: true` then presses the keyboard's submit key. `force` is as for `tap`. Answers `Typed into <element>. Value is now \"…\"` and what changed.",
    "tapline": "Tapline: sets the value through the input's handlers."
  },
  "scroll": {
    "shared": "Scroll content: `down` shows what is below. `direction` (default `down`), `amount` (0.1-1.0 of the scroll area, default 0.8), `to` (`start` or `end`, repeats until nothing changes; or `target`, until the `target` element is on screen and clear of the bars) and `target` (the scroll view, or an element inside it; default the screen's main scroll view) shape it. Answers what changed.",
    "tapline": "Tapline: scrolls the view through its handle; the main scroll view is the largest one."
  },
  "toggle": {
    "shared": "Set a switch or checkbox. `target` picks it; `value` true or false sets it (nothing happens if it's already there); omit `value` to flip it. Answers the new state and what changed.",
    "tapline": "Tapline: sets it through the handler."
  },
  "back": {
    "shared": "Go back one screen. An open sheet or popover closes first, where it can be closed. Answers what changed; `not_actionable: no_action` when there is nothing to go back to.",
    "tapline": "Tapline: uses the router (React Navigation or Expo Router)."
  },
  "open_url": {
    "shared": "Open a URL or deep link, like \"myapp://settings\". Answers what came up and what changed.",
    "tapline": "Tapline: hands it to iOS from inside the app; the app's own links open in it, others leave it."
  },
  "wait": {
    "shared": "Wait `seconds` (0.1-30, required) for an animation, a load or navigation, then answer what changed. Out-of-range values are `bad_params`. Answers `Waited 1.0 s.` and the changes."
  },
  "wait_for": {
    "shared": "Wait until something shows on screen: one of `text`, `id` or `label`; with `gone: true`, until it's gone (a spinner). `timeout` is 0.5-30 s (default 10). Returns as soon as it's true, with `Done after 1.2 s.` and what changed, or `timeout`.",
    "tapline": "Tapline: also takes `network_idle` (no request in flight)."
  },
  "apps": {
    "shared": "List the apps you can drive, with the current one marked and the ids `open_app` takes.",
    "tapline": "Tapline: the apps connected to this computer, with session ids."
  },
  "open_app": {
    "shared": "Drive this app from now on. `app` is an id or a name (names match ignoring case). Several matches give `ambiguous` with their `apps` lines.",
    "tapline": "Tapline: selects a connected app. It can't launch apps: when the app isn't connected, it answers `not_connected` with how to connect it."
  },
  "viewer": {
    "shared": "The link to the live view, where the user can watch the app as you work and take over. Their touches go first, and they can pause you. Give the link to the user only.",
    "tapline": "Tapline: opens in a browser; also reports capture time and stutter while frames are on."
  }
} as const satisfies Record<string, { readonly shared: string; readonly tapline?: string }>;

/** Tapline extras (TOOL-TEXT section 3). */
export const EXTRA_TOOL_TEXT = {
  "check_layout": "Checks the current screen from the element tree, with no screenshot: tap areas under 44x44 pt, elements cut off at the edges, overlaps, text contrast below WCAG, buttons with no label, and text likely cut off. Findings name elements by ref.",
  "run": "Runs several steps in one call, in order, and answers once: `Ran 5 of 5 steps in 3.4 s.` then the changes since your last list. Each step is a tool call written as an object (`{\"tool\": \"tap\", \"target\": {\"id\": \"save\"}}`) with an optional `expect` checked after it: one of text, id or label, with gone, value (a switch: \"on\"/\"off\") and timeout (default 2 s). It stops at the first step that fails or whose expectation doesn't hold and says which: `Error expect_failed: Ran 3 of 5 steps; stopped at step 4 (tap \"Save\"): text \"Saved\" didn't appear within 2 s.` Use it to fill a form or walk a flow you're sure of; read the answer before the next batch.",
  "inspect": "Shows where an element comes from, in a development build: the components that draw it (screen first), the file and line of the app's code that wrote it, that line itself, and the component's props in short. Use it to say where to fix a bug you found. Release builds answer unsupported.",
  "compare_screen": "Visual regression: the first call for a `name` (or with `update: true`) saves the screen as the reference; later calls compare it pixel by pixel and report how much changed, where, and an image with changes in red. Keep the same `width` for a name.",
  "filmstrip": "Several screenshots in one numbered image, for animations and loading states; cheaper than separate shots. `tap` first taps an element, then films what it sets off.",
  "record": "Record a run as a script to replay without an AI: `start` with a `name`, then every action becomes a step, then `stop` saves it. Also `status` and `discard`. Targets are saved by id, else label, else text; refs only last one run.",
  "replay": "Run a saved script step by step and report each step. It stops at the first step that fails or ends on a different screen. Without `name`, lists saved scripts.",
  "logs": "Recent console output and JS errors from the app (last 500). `since` (epoch ms) returns only newer lines; each result ends with the latest timestamp to reuse.",
  "reload": "Reload the JavaScript bundle (development builds only), wait for the app to reconnect, and answer the screen. If it isn't back in time, it says so: `look` again shortly. Other builds answer `unsupported`.",
  "app_command": "Without `name`, lists the commands the app offers for testing (switch language, sign in as a test user, load sample data). With `name` and `args`, runs one and answers its result and what changed. Built in: `appearance` (`light`, `dark`, `system`).",
  "swipe": "Drag from `x0, y0` to `x1, y1`, in points, over `seconds` (default 0.35). For sliders, carousels, swipe actions and edge gestures; for lists, use `scroll`.\nTapline: drives what React Native's touch system handles (a pan view, a sheet's swipe to close); a gesture that react-native-gesture-handler or a native view handles (sliders, maps) answers `no_action`, and its message says what can make it.",
  "pair": "Make a pairing link and QR code for the user's phone (valid 10 minutes, works once). The user scans it and taps Connect in the app. Needs the app's URL scheme. Show the user the QR code."
} as const satisfies Record<string, string>;
