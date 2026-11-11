// Native alerts (Alert.alert / Alert.prompt) are drawn by the OS: an agent that drives the app
// through component handlers can neither see nor press them. This module records them and,
// optionally, replaces them with an in-app stand-in made of ordinary views.
import React, { useRef, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  AppRegistry,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type AlertButton,
  type AlertOptions,
} from 'react-native';
import { currentCover } from './native';
import { noteRealTouch } from './touches';

export interface AlertButtonInfo {
  text: string;
  style: 'default' | 'cancel' | 'destructive';
}

export interface OpenAlert {
  id: number;
  kind: 'alert' | 'prompt';
  title: string;
  message: string | null;
  buttons: AlertButtonInfo[];
  at: number;
  standIn: boolean;
}

type AlertFn = typeof Alert.alert;
type PromptFn = typeof Alert.prompt;
type ButtonHandler = AlertButton['onPress'];

interface Entry {
  info: OpenAlert;
  /** The app's own handlers, one per button, in the order of `info.buttons`. */
  handlers: ButtonHandler[];
}

const DEFAULT_OK = 'OK';

let installed = false;
let standInMode = false;
let wrapperRegistered = false;
let originalAlert: AlertFn | null = null;
let originalPrompt: PromptFn | null = null;
let nextId = 1;
/** True while our wrapper is inside the original: iOS `Alert.alert` calls `Alert.prompt`. */
let delegating = false;

let queue: Entry[] = [];
const hosts: object[] = [];
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion(): number {
  return version;
}

function closeAlert(id: number): void {
  ownAlertIds.delete(id);
  const next = queue.filter((entry) => entry.info.id !== id);
  if (next.length === queue.length) return;
  queue = next;
  notify();
}

function callHandler(handler: ButtonHandler, args: unknown[]): unknown {
  if (typeof handler !== 'function') return undefined;
  return Reflect.apply(handler, undefined, args);
}

function styleOf(button: AlertButton): AlertButtonInfo['style'] {
  return button.style === 'cancel' || button.style === 'destructive' ? button.style : 'default';
}

function describeButtons(buttons: AlertButton[] | undefined): AlertButtonInfo[] {
  if (!buttons || buttons.length === 0) return [{ text: DEFAULT_OK, style: 'default' }];
  return buttons.map((button) => ({ text: String(button.text ?? ''), style: styleOf(button) }));
}

/** The app's handlers for a plain alert or a prompt's buttons / callback. */
function handlersFor(buttons: AlertButton[] | ((text: string) => void) | null | undefined): ButtonHandler[] {
  if (typeof buttons === 'function') return [buttons];
  if (!buttons || buttons.length === 0) return [undefined];
  return buttons.map((button) => button.onPress);
}

function record(
  kind: OpenAlert['kind'],
  title: string | null | undefined,
  message: string | null | undefined,
  buttons: AlertButton[] | ((text: string) => void) | null | undefined,
  standIn: boolean,
): Entry {
  const list = typeof buttons === 'function' || !buttons ? undefined : buttons;
  const entry: Entry = {
    info: {
      id: nextId++,
      kind,
      title: title == null ? '' : String(title),
      message: message == null || message === '' ? null : String(message),
      buttons: describeButtons(list),
      at: Date.now(),
      standIn,
    },
    handlers: handlersFor(buttons),
  };
  queue = [...queue, entry];
  notify();
  return entry;
}

function wrapButtons(
  id: number,
  buttons: AlertButton[] | ((text: string) => void) | null | undefined,
): AlertButton[] {
  const closing = (handler: ButtonHandler) => (...args: unknown[]) => {
    closeAlert(id);
    return callHandler(handler, args);
  };
  if (typeof buttons === 'function' || !buttons || buttons.length === 0) {
    return [{ text: DEFAULT_OK, onPress: closing(typeof buttons === 'function' ? buttons : undefined) }];
  }
  return buttons.map((button) => ({ ...button, onPress: closing(button.onPress) }));
}

function wrapOptions(id: number, options: AlertOptions | undefined): AlertOptions {
  const onDismiss = options?.onDismiss;
  return {
    ...options,
    onDismiss: () => {
      closeAlert(id);
      onDismiss?.();
    },
  };
}

function runOriginal<Args extends unknown[]>(original: (...args: Args) => void, args: Args): void {
  const previous = delegating;
  delegating = true;
  try {
    original(...args);
  } finally {
    delegating = previous;
  }
}

function trackedAlert(...args: Parameters<AlertFn>): void {
  const original = originalAlert;
  if (!original) return;
  if (delegating) {
    original(...args);
    return;
  }
  let entry: Entry | null = null;
  let forwarded: Parameters<AlertFn> | null = null;
  try {
    const [title, message, buttons, options] = args;
    entry = record('alert', title, message, buttons, standInMode);
    if (!standInMode) {
      forwarded = [title, message, wrapButtons(entry.info.id, buttons), wrapOptions(entry.info.id, options)];
    }
  } catch {
    if (entry) closeAlert(entry.info.id);
    entry = null;
    forwarded = null;
  }
  if (entry && standInMode) return;
  if (!entry || !forwarded) {
    runOriginal(original, args);
    return;
  }
  try {
    runOriginal(original, forwarded);
  } catch (error) {
    closeAlert(entry.info.id);
    throw error;
  }
}

function trackedPrompt(...args: Parameters<PromptFn>): void {
  const original = originalPrompt;
  if (!original) return;
  if (delegating) {
    original(...args);
    return;
  }
  let entry: Entry | null = null;
  let forwarded: Parameters<PromptFn> | null = null;
  try {
    const [title, message, callbackOrButtons, type, defaultValue, keyboardType, options] = args;
    // A prompt of type "default" has no text field: iOS shows a plain alert (it's how iOS's own
    // Alert.alert works, reached here when code kept the original Alert.alert from before Tapline).
    const kind = type === 'default' && typeof callbackOrButtons !== 'function' ? 'alert' : 'prompt';
    entry = record(kind, title, message, callbackOrButtons, standInMode);
    if (!standInMode) {
      const id = entry.info.id;
      const wrapped = wrapButtons(id, callbackOrButtons);
      // Keep the callback form when the app used it, so native behaviour is unchanged.
      const callback = typeof callbackOrButtons === 'function' ? callbackOrButtons : null;
      const third: Parameters<PromptFn>[2] = callback
        ? (text: string) => {
            closeAlert(id);
            callback(text);
          }
        : wrapped;
      forwarded = [title, message, third, type, defaultValue, keyboardType, wrapOptions(id, options)];
    }
  } catch {
    if (entry) closeAlert(entry.info.id);
    entry = null;
    forwarded = null;
  }
  if (entry && standInMode) return;
  if (!entry || !forwarded) {
    runOriginal(original, args);
    return;
  }
  try {
    runOriginal(original, forwarded);
  } catch (error) {
    closeAlert(entry.info.id);
    throw error;
  }
}

/**
 * Watches for real touches: it sees a touch start on its way down and says "not mine" (false), so
 * the app's own views get the touch as if this view were not there. A `Modal` is another native
 * window, so touches inside one never pass through here.
 */
function watchTouch(): boolean {
  if (installed) noteRealTouch(Date.now());
  return false;
}

/** The one wrapper around the app's root: it watches touches and, in stand-in mode, hosts the alert. */
function Wrapper({ children }: { children?: React.ReactNode }): React.ReactElement {
  // The provider cannot be unset, so after uninstall the wrapper stays (the tree must not change
  // shape under a running app) but does nothing. Children keep one position either way.
  return (
    <View style={styles.fill} onStartShouldSetResponderCapture={watchTouch}>
      {children}
      {installed && standInMode ? <TaplineAlertHost /> : null}
    </View>
  );
}

export function installAlertTracking(options?: { standIn?: boolean }): void {
  const standIn = options?.standIn === true;
  if (!installed) {
    installed = true;
    originalAlert = Alert.alert;
    Alert.alert = trackedAlert;
    if (typeof Alert.prompt === 'function') {
      originalPrompt = Alert.prompt;
      Alert.prompt = trackedPrompt;
    }
  }
  standInMode = standIn;
  if (!wrapperRegistered) {
    wrapperRegistered = true;
    AppRegistry.setWrapperComponentProvider(() => Wrapper);
  }
}

export function uninstallAlertTracking(): void {
  if (installed) {
    if (originalAlert) Alert.alert = originalAlert;
    if (originalPrompt) Alert.prompt = originalPrompt;
  }
  installed = false;
  standInMode = false;
  wrapperRegistered = false;
  originalAlert = null;
  originalPrompt = null;
  delegating = false;
  const hadAlerts = queue.length > 0;
  queue = [];
  if (hadAlerts || listeners.size > 0) notify();
}

/** Ids of Tapline's own prompts (nativeAlert) while they are open. */
const ownAlertIds = new Set<number>();

/** True for an open alert that is one of Tapline's own prompts, which only the person answers. */
export function isOwnAlert(id: number): boolean {
  return ownAlertIds.has(id) && queue.some((entry) => entry.info.id === id);
}

/**
 * A real (native) alert, never replaced by the stand-in: for Tapline's own prompts, such as
 * "Connect for testing?", which only the person holding the phone should answer. It is listed as
 * a real alert (not a stand-in) while open, so the agent sees it and its taps behind it are
 * refused, but it has no way to press its buttons.
 */
export function nativeAlert(...args: Parameters<AlertFn>): void {
  const show = originalAlert ?? Alert.alert;
  const [title, message, buttons, options] = args;
  let entry: Entry | null = null;
  let forwarded: Parameters<AlertFn> = args;
  try {
    entry = record('alert', title, message, buttons, false);
    ownAlertIds.add(entry.info.id);
    forwarded = [title, message, wrapButtons(entry.info.id, buttons), wrapOptions(entry.info.id, options)];
  } catch {
    if (entry) closeAlert(entry.info.id);
    entry = null;
    forwarded = args;
  }
  // iOS's Alert.alert calls Alert.prompt, which is ours while tracking: pass it through untouched,
  // or the stand-in would draw this alert and an agent could answer it.
  try {
    runOriginal((...shown: Parameters<AlertFn>) => show.apply(Alert, shown), forwarded);
  } catch (error) {
    if (entry) closeAlert(entry.info.id);
    throw error;
  }
}

/** The id of an alert that only the native module saw (an alert or the share sheet UIKit shows). */
export const NATIVE_COVER_ID = -1;

export function openAlerts(): OpenAlert[] {
  const tracked = queue.map((entry) => ({ ...entry.info, buttons: entry.info.buttons.map((button) => ({ ...button })) }));
  const cover = currentCover();
  if (cover === null) return tracked;
  // An Alert.alert tracked here (without the stand-in) is the same alert UIKit shows: listed once.
  if (cover.kind !== 'share' && tracked.some((alert) => !alert.standIn && alert.title === cover.title)) return tracked;
  const native: OpenAlert = {
    id: NATIVE_COVER_ID,
    kind: 'alert',
    title: cover.kind === 'share' ? 'Share sheet' : cover.title,
    message: cover.message === '' ? null : cover.message,
    buttons: cover.buttons.map((button) => ({ text: button.text, style: button.destructive ? 'destructive' : 'default' })),
    at: 0,
    standIn: false,
  };
  return [...tracked, native];
}

function answer(entry: Entry, index: number, text: string | undefined): void {
  closeAlert(entry.info.id);
  const handler = entry.handlers[index];
  try {
    if (entry.info.kind === 'prompt') callHandler(handler, [text ?? '']);
    else callHandler(handler, []);
  } catch (error) {
    // The app's handler failed: surface it like a native press would, but not inside our render.
    setTimeout(() => {
      throw error;
    }, 0);
  }
}

function AlertCard({ entry }: { entry: Entry }): React.ReactElement {
  const [text, setText] = useState('');
  const { info } = entry;
  return (
    <View testID="tapline-alert" accessibilityViewIsModal style={styles.overlay}>
      <View style={styles.card}>
        <Text style={styles.title}>{info.title}</Text>
        {info.message !== null ? <Text style={styles.message}>{info.message}</Text> : null}
        {info.kind === 'prompt' ? (
          <TextInput
            testID="tapline-alert-input"
            style={styles.input}
            value={text}
            onChangeText={setText}
            autoCapitalize="none"
            autoCorrect={false}
          />
        ) : null}
        <View style={styles.buttons}>
          {info.buttons.map((button, index) => (
            <Pressable
              key={index}
              testID={`tapline-alert-button-${index}`}
              accessibilityRole="button"
              style={styles.button}
              onPress={() => answer(entry, index, text)}
            >
              <Text
                style={[
                  styles.buttonText,
                  button.style === 'destructive' && styles.destructive,
                  button.style === 'cancel' && styles.cancel,
                ]}
              >
                {button.text}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

/** Draws the oldest open stand-in alert. Only the first mounted host renders. */
export function TaplineAlertHost(): React.ReactElement | null {
  const token = useRef<object>({}).current;
  useSyncExternalStore(subscribe, getVersion);
  React.useEffect(() => {
    hosts.push(token);
    notify();
    return () => {
      const at = hosts.indexOf(token);
      if (at >= 0) hosts.splice(at, 1);
      notify();
    };
  }, [token]);

  if (hosts[0] !== token) return null;
  const entry = queue.find((candidate) => candidate.info.standIn);
  if (!entry) return null;
  return <AlertCard key={entry.info.id} entry={entry} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 20,
  },
  title: { fontSize: 17, fontWeight: '600', color: '#000000', textAlign: 'center' },
  message: { fontSize: 14, color: '#333333', textAlign: 'center', marginTop: 8 },
  input: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#999999',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    color: '#000000',
  },
  buttons: { marginTop: 16 },
  button: { paddingVertical: 12, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#cccccc' },
  buttonText: { fontSize: 17, color: '#0a84ff' },
  destructive: { color: '#d70015' },
  cancel: { fontWeight: '600' },
});
