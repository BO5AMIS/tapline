---
name: tapline
description: Use when testing, exploring or driving the user's own React Native or Expo app on their real phone through Tapline (MCP tools such as look, tap, type_text, scroll, wait_for, open_url, app_command, logs), when asked for QA, a UI check or a bug hunt on that app, when setting Tapline up for a user or adding its SDK to an app, or when a Tapline call answers not_connected, in_background, not_actionable, not_answering or reconnecting.
license: MIT
compatibility: Needs the Tapline MCP server (`tapline mcp`, Node.js 20 or later) on the user's computer, and a development or TestFlight build of the app with Tapline's SDK switched on. Works from Windows, macOS or Linux.
metadata:
  tool: tapline
  interface: AGENT-TOOLS v1.6
---

# Tapline: test your own app on a real phone

Tapline gives you eyes and hands inside the user's own app on their phone: you read the
screen as a list of elements and act on them. It reads the app's React tree and calls the
app's handlers, so it is fast and it can't leave that app. This skill is how to do that
well. The tools describe themselves; what follows is what they can't tell you.

## 1. Before you start

- **No Tapline tools in your tool list?** Set it up first:
  [references/setup.md](references/setup.md).
- **Call `apps` once.** It lists the app that is connected. When none is: a phone that never
  paired needs `pair` (show the user the QR code); a paired one only needs the user to open
  the app with Tailscale on.
- **The app must stay open in front.** iOS pauses an app in the background, also when the
  user switches to another app to chat with you. `in_background` means a person must bring
  it back: ask, and wait.
- **Only this app.** System dialogs (permissions, the share sheet, Face ID), the keyboard,
  other apps and the home screen are out of reach. Say that you couldn't test them. Tapwright
  covers them.
- **A person may be watching** in the live view (`viewer` gives the link) and can take over.
  Their input goes first.

## 2. The loop: look, act, read the answer

1. `apps` shows the connected app. `open_url` with a deep link jumps straight to a screen.
2. `look` reads the screen: a header, then one line per element.
3. Act on one element. **Every action answers with what changed. Read that before the next
   call**: it usually holds what you were about to look for.

```
tap {"target": {"id": "login-button"}}

Tapped e3 button "Log in" id=login-button @24,610 354x48.
Same screen. Changes:
+ e9 text "Wrong password" @24,560 354x20
~ e2 input "Password" id=password @24,500 354x48 [tap, type] (was "hunter2")
Settled in 0.31 s.
```

The answer already shows the error text, and that the field was emptied. No `look` is needed.

Name the element with one of, in this order of preference: `id` (the app's own identifier,
React Native's `testID`), `ref` (from your last list, like `e3`), `label`, `text`. Use `x`
and `y` only for things with no element.

## 3. Reading an answer

- **The first line** says what was done and to which element.
- **`Same screen. Changes:`** then `+` new, `-` gone, `~` changed (with what it was),
  `↕` moved. When most of the screen changed, the full list comes instead.
- **`No visible change.`** means nothing changed, on screen or off it.
- **A sheet, an alert or a new screen answers with the full list:** the first line, then
  `Screen …` and the elements that are in front now. What a sheet hides is left out until it
  closes; acting on it answers `covered: … close that first.` When something out of view
  changed as well, it follows the list under `Changes off screen:`.
- **The header counts what you can't see:**
  `Screen 430x932 pt @3x · 26 elements (+41 below, +2 above)`. Those 41 are reached by
  scrolling. They are not in the list: acting on one answers `off_screen` and names the call
  that brings it up. `Route:` names the screen you are on, and `Network:` says requests are still
  running.
- **A change out of view has its own line, without a ref:**
  ```
  Same screen. Changes:
  ~ text "taps=2" id=lab-state @16,-900 398x60 (off screen; was "taps=1")
  ```
  The action worked. You don't need to scroll there to check.
- **After answers you asked to be short (`look: false`), the next block covers them too:**
  ```
  Same screen. Changes:
  No visible change.
  Note: changes are since your last list, 2 actions ago.
  ```
  A sheet opened by the first action and closed by the second shows as no change. That is
  true of the two together; it doesn't mean the second did nothing.
- **Refs** stay with their elements from answer to answer. Only `look` starts again at `e1`,
  so after a `look` use the new list's refs.
- **Long text is cut** and says by how much: `"…(+57)"`. `wait_for` with the text checks all
  of it.
- **The keyboard:** `Keyboard: shown` or `Keyboard: hidden` in an answer says it came or went.
  While it is up, a touch on anything but the field you are typing in closes it first, as a
  person would, and the answer ends with `Note: closed the keyboard first.` Typing into the
  next field of a form leaves it up.
- **`Note:` lines come last.** Read them: they say when something didn't go the plain way
  (a person touched the phone, the keyboard was closed first, an action was forced).

## 4. To do this, call that

| To | Call |
|---|---|
| reach an element that is off screen | `scroll` with it as `target` and `to: "target"`. One call; don't scroll by guess |
| wait for a load, a spinner or a new screen | `wait_for` with `text`, `id` or `label` (`gone: true` for a spinner; `network_idle` for requests), not `wait` |
| set a switch, or read it | `toggle` with `value: true` or `false`. It does nothing if the switch is already there, and its answer says the switch's state either way |
| fill a field and send it | `type_text` with `submit: true` |
| leave a screen, or close a sheet | `back`. Not every sheet closes that way: if it answers `no_action`, the sheet has only its own close control, and the message names the sheet. Tap that control |
| check that something appeared | read the action's answer; `look` only if it isn't there |
| pick one of several elements with the same text | its `id` if it has one; else add `index` to the target (0-based, in reading order), or use a ref from the `ambiguous` answer's candidates |
| see pixels (layout, colours, images) | `check_layout` first: it finds small tap areas, cut-off or overlapping text and low contrast without a picture. Then `look`, or `screenshot: true` on an action. Pictures cost many tokens: drive by text |
| run steps whose answers you don't need | `look: false` on them, then read the next full answer and its note |
| work with Tapwright and Tapline both connected | inside the app under test, Tapline's tools: its reads and actions are the fast ones. For what iOS draws (permission prompts, system alerts, the share sheet), other apps, real gestures, and the live view: Tapwright's. A ref belongs to the tool that gave it: never pass one tool's ref to the other; use the element's `id` with either |
| jump straight to a screen | `open_url` with the app's deep link |
| reach a state quickly (a language, a test sign-in, sample data, dark mode) | `app_command`; without a name it lists what the app offers. Put things back when you're done |
| find out why a screen is broken | `logs`: JavaScript errors and failed requests (`[network]` lines) |
| start from a fresh state | `reload` (development builds) |
| answer an alert | the app's alert shows as an `Alert:` line in the header (in a build with Tapline's native module, also an alert iOS draws, and the share sheet as `Alert: "Share sheet"`). With Tapline's stand-in its buttons are also in the list: tap them. When the note says it is an OS alert, Tapline can't tap it: ask the user to tap the button you name |
| keep a flow to run again after a change | `record` with `start`, act, `record` with `stop`; later `replay` |
| compare a screen with how it looked before | `compare_screen` with a name |
| see an animation or a loading state | `filmstrip`: several frames in one picture |
| let the user watch, or do a step themselves (their own password) | `viewer`, and give them the link |

**With both tools connected:** when the two tools answer differently, both are right about their own way in: Tapwright does what a finger can do, Tapline what the app's own code allows (Tapline's `back` calls a sheet's own close; Tapwright's needs a gesture the sheet accepts). Test what the user can do with Tapwright; use Tapline to get there faster. Each tool's `was` is from its own last answer: after the other tool acted, read the current value, not the old one.

## 5. Errors

Every failure is `Error <code>: <message>`, and the message says what to do next.

| Code | Do |
|---|---|
| `not_found` | `look`, then pick another target |
| `ambiguous` | use one of the listed refs, or add `index` |
| `not_actionable` | the first word is why: `disabled`, `off_screen`, `covered`, `under_tab_bar`, `behind_alert`, `no_action`. Fix the cause: `scroll` with `to: "target"`, close what is in front, answer the alert |
| `stale` | a person changed the screen since your list: `look` again |
| `busy` | a person is using the app: wait a few seconds, retry |
| `paused`, `in_background` | ask the user (to resume; to open the app again) |
| `not_connected` | no app to drive: follow the message (pair the phone, or ask the user to open the app) |
| `not_answering` | the app froze: try once more; if it repeats, ask the user to close the app and open it again (Tapline can't close apps) |
| `reconnecting` | wait a few seconds, then `look` |
| `timeout` | the action may have happened: `look` before you retry |
| `unsupported` | Tapline can't do this: use what the message names |
| `bad_params` | fix the call |
| `internal` | a bug in the tool: report it with the call you made |

## 6. Testing well

1. **Write down what you will check** before touching anything: the flows, and for each
   step what should happen.
2. **For each step:** say what you expect, act, read the answer, compare. A step passes on
   what the answer shows, not on the absence of an error.
3. **Go beyond the happy path:** empty and wrong input, buttons that should be disabled
   until a form is valid, going back, content that is scrolled out of view, the same action
   twice.
4. **Keep going after a failure** where you can. Record it and test the rest.
5. **Note what you couldn't test** and why (a login you have no account for, Face ID, a
   purchase). That is not a bug, and it must not be reported as one.
6. **Keep evidence:** the answer lines that show the problem, and a screenshot of that
   moment when the picture matters.
7. **A control that must not work** (disabled, covered, behind a sheet or an alert) passes
   when the action is refused with that reason and nothing changed. That refusal is the
   evidence. Don't use `force` to check it.

An element you can only reach by `x` and `y`, with no id and no label, is a finding too: a
person using VoiceOver can't reach it either.

Tapline calls the app's handlers; it doesn't make real touches. A control that only reacts
to a gesture (swipe to delete, drag, pinch) can't be tested this way: say so, don't guess.
A refusal (`covered`, `off_screen`, `disabled`) on something a user is meant to reach is
often the bug itself. Read `logs` after anything that misbehaves, and once at the end.

**The report**, one entry per problem:

```
What: one sentence.
Steps: the calls, short.
Expected: …
Got: … (quote the answer line)
Where: screen, element (its id or label).
Evidence: screenshot moment, if any.
```

Then, apart from the bugs: what passed, what you couldn't test and why, and screens that
took more than a few seconds (`Settled in` gives the time).

## 7. Safety

- It is the user's own phone and their real app data. Don't buy, subscribe, send messages or
  email, post, delete data, or change account, privacy or security settings, unless the user
  asked for exactly that step. Ask when unsure.
- Use the test accounts and test data the user gives you. Never sign in with credentials
  you find in the app or its logs.
- Don't read or repeat private content you see (messages, photos, notifications) beyond
  what the test needs.
- Stay in the app under test.
- Give the live view's link to the user only. It carries a key. A pairing link lets a phone
  connect for ten minutes: show it to the user only. Never print the token in
  `~/.tapline/token`.
- Tapline belongs in development and TestFlight builds only. When you help with a release
  build, check that its profile doesn't set `EXPO_PUBLIC_TAPLINE_ENABLED`.

## 8. Common mistakes

| Mistake | Instead |
|---|---|
| a `look` after every action | read the action's answer; it has the changes |
| a `look` to read one value that an answer already showed | use the `~` line, also when it says `off screen` |
| scrolling by guess to find something | `scroll` with the target and `to: "target"`; the header says whether more lies below |
| `force: true` to get past a refusal | fix the cause. The refusal's message offers `force` for one case only: you have decided the refusal itself is wrong. Then say in the report that you forced it. With `force` the handler runs although a person couldn't have pressed it, and the answer says so: that hides the bug you were sent to find |
| retrying at once after `timeout` | `look` first: the action may have happened, and a retry would do it twice |
| `wait` with a guessed number of seconds | `wait_for` what you are waiting for |
| reading "No visible change." after `look: false` steps as "nothing happened" | read the note: the block covers all of them |
| calling `back` again when it answered `no_action` | the message names what is open: tap its close control |
| using `x` and `y` because a ref went stale | `look`, then use the id or the new ref |
| reporting "couldn't sign in" as a bug | list it under what you couldn't test |
| reporting a swipe-only control as broken because `tap` did nothing | say that Tapline can't make that gesture |
| going on after the user left the app | stop: Tapline works only while its app is open in front |
