# @tapline/react-native

The in-app agent of [Tapline](../../README.md): lets an AI agent on your computer see and
drive **your own** React Native / Expo app on your phone, from anywhere, over Tailscale.
Pure TypeScript; no native code, no config plugin. Full setup:
[docs/setup.md](../../docs/setup.md).

## Use

First line of the app's entry file (for Expo Router, your own `index.js` that then imports
`expo-router/entry`):

```js
import '@tapline/react-native/register';
import { startTapline } from '@tapline/react-native';

startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });
```

- The build carries no address and no token, only the switch. Set it in development and
  test builds only. With it off, Tapline does nothing at all.
- With it on, the app pairs when a pairing link opens it
  (`<scheme>://tapline/pair?url=…&code=…&name=…`, from the computer's QR code): it asks
  "Connect for testing?", connects with the one-time code, and keeps the token the
  computer sends back. From then on it reconnects to that computer whenever it's open
  (1, 2, 4 … 30 s between tries). `<scheme>://tapline/forget` unpairs. It never throws
  into the app.
- Expo Router: add `app/+native-intent.ts` so the router leaves pairing links alone:

  ```ts
  import { isTaplineLink } from '@tapline/react-native';

  export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
    return isTaplineLink(path) ? null : path;
  }
  ```

- `expo-secure-store` (when installed) keeps the pairing in the keychain; without it the
  pairing lasts until the app restarts, or pass `storage` (`getItem`, `setItem`,
  `removeItem`, async). Each install also keeps a random id there, so the computer can
  tell two phones apart.
- Optional: `app: { name, id, version, build }` names the app for the host; `url` and
  `token` connect straight to a host without pairing (a simulator on the same computer);
  `stopTapline()` shuts it down. `react-native-view-shot` for screenshots.
- The method functions (`tree`, `press`, `longPress`, `typeText`, `scroll`, `toggle`,
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
- Refs (`e1`, `e2` …) are numbered per `tree` and stay valid until the next one; refs in
  an `ambiguous` error are valid too.
- Requests run one at a time; each has 30 s.

## Limits

- Only the app's own UI: no system dialogs, keyboard, other apps or home screen.
- Actions call handlers; they aren't touches. Gesture-only controls (swipe handlers, drag,
  pinch, `PanResponder`) and views React doesn't render (maps, web view contents) are out
  of reach.
- Release builds shorten component names: element types read best in development builds,
  and `testID`s keep targeting reliable.
- Not confirmed on a device yet: measuring under the new architecture, the hook in release
  builds, finding the focused input under the new architecture (`type` without a target
  then needs exactly one input on screen), and the scroll offset after the user has
  scrolled a plain `ScrollView` by hand. On iOS the device model and name aren't sent (the
  install id stands in).
- Turn it on only in builds you test with: the computer it's paired with can drive the
  app while it's connected.
