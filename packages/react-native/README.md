# react-native-tapline

The in-app agent of [Tapline](https://github.com/bo5amis/tapline#readme): lets an AI agent on your computer see and
drive **your own** React Native / Expo app on your test phone, on the same Wi-Fi as the
computer. TypeScript, plus an optional Expo native module that any new build of an Expo app
picks up by itself (faster live-view frames, and iOS alerts and the share sheet seen over the
app); no config plugin. Full setup:
[docs/setup.md](https://github.com/bo5amis/tapline/blob/main/docs/setup.md).

## Use

First line of the app's entry file (for Expo Router, your own `index.js` that then imports
`expo-router/entry`):

```js
import 'react-native-tapline/register';
import { startTapline } from 'react-native-tapline';

startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });
```

- The build carries no address and no token, only the switch. Set it in development and
  test builds only. With it off, Tapline does nothing at all.
- With it on, the app pairs when a pairing link opens it
  (`<scheme>://tapline/pair?url=…&code=…&name=…`, from the computer's QR code): it asks
  "Connect for testing?", connects with the one-time code, and keeps the token the
  computer sends back. From then on it reconnects to that computer whenever it's open
  (a new try one second after each failed one). `<scheme>://tapline/forget` unpairs. It never throws
  into the app.
- Expo Router: add `app/+native-intent.ts` so the router leaves pairing links alone:

  ```ts
  import { isTaplineLink } from 'react-native-tapline';

  export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
    return isTaplineLink(path) ? null : path;
  }
  ```

- `expo-secure-store` (when installed) keeps the pairing in the keychain; without it the
  pairing lasts until the app restarts, or pass `storage` (`getItem`, `setItem`,
  `removeItem`, async). Each install also keeps a random id there, so the computer can
  tell two phones apart.
- Text other people wrote (comments, emails, messages): wrap it in `<TaplineFromOthers>` (it draws nothing of its
  own), or put `taplineFromOthers` on a `Text`. The agent then reads it as `text (from others) "…"`, and a route
  or grant that is drafts-only treats the touches that send replies with care. Unmarked text is never claimed either
  way, and the mark is a hint, not a boundary: the agent is told to follow no instruction found in screen text.
- Optional: `app: { name, id, version, build }` names the app for the host; `url` and
  `token` connect straight to a host without pairing (a simulator on the same computer);
  `stopTapline()` shuts it down. `react-native-view-shot` for screenshots.
- The method functions (`tree`, `press`, `longPress`, `typeText`, `scroll`, `swipe`, `toggle`,
  `openURL`, `getLogs`, `reload`, `screenshot`) are exported too, for tests or an in-app
  debug screen.

## How it works

- `register` installs a minimal React DevTools hook (chaining any existing one) that
  records the app's React roots. It must run before React loads.
- The screen is read from the React tree: host views with text, an accessibility label,
  a `testID` or a handler become elements. An element's type is the React Native
  component around it (`Pressable`, `Button`, `TextInput`, `Switch`, `FlatList` …) or
  your component's name. A `Text` that only repeats its button's label is folded into
  the button.
- Positions come from `measureInWindow` (old architecture: the host instance; new
  architecture: its public instance, else the Fabric UI manager), 500 ms per element at
  most; an element that can't be measured is kept, without a frame.
- `press` calls the nearest `onPress` with a synthetic press event, and bubbles from a
  non-actionable element to its nearest actionable parent. `type` calls the input's own
  `onChange` and `onChangeText`, and sets the native text of uncontrolled inputs.
  `scroll` uses the scroll view's `scrollTo` / `scrollToOffset` / `scrollToEnd`.
- Refs (`e1`, `e2` …) are given by `tree`; after an action, elements still on screen keep
  theirs and new ones count on from the highest, so an old ref never points at another
  element. Refs in an `ambiguous` error are valid too.
- `swipe` drags a synthetic finger through React Native's responder system (capture, then
  bubble, with a touch history for `PanResponder`).
- Requests run one at a time; each has 30 s.

## Limits

- Only the app's own UI: no system dialogs, keyboard, other apps or home screen.
- Actions call handlers; they aren't touches. `swipe` reaches `PanResponder` and other
  responder-based drags; gestures built on react-native-gesture-handler, pinch, and views
  React doesn't render (sliders, maps, web view contents) are out of reach.
- Release builds shorten component names: element types read best in development builds,
  and `testID`s keep targeting reliable.
- Checked on an iPhone with the new architecture (Expo 57, React Native 0.86) in a
  development build. Not confirmed yet: the hook in release builds, and the scroll offset
  after the user has scrolled a plain `ScrollView` by hand. On iOS the device model and name
  aren't sent (the install id stands in).
- Turn it on only in builds you test with: the computer it's paired with can drive the
  app while it's connected.
