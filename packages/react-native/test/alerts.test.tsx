import '../src/register';
import React from 'react';
import { Alert, AppRegistry, View } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import {
  installAlertTracking,
  openAlerts,
  TaplineAlertHost,
  uninstallAlertTracking,
} from '../src/alerts';
import { mount, unmountAll } from './helpers';

type AlertArgs = Parameters<typeof Alert.alert>;
type PromptArgs = Parameters<typeof Alert.prompt>;

let alertSpy: jest.SpyInstance<void, AlertArgs>;
let promptSpy: jest.SpyInstance<void, PromptArgs>;
let wrapperSpy: jest.SpyInstance;

beforeEach(() => {
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  promptSpy = jest.spyOn(Alert, 'prompt').mockImplementation(() => undefined);
  wrapperSpy = jest.spyOn(AppRegistry, 'setWrapperComponentProvider').mockImplementation(() => undefined);
});

afterEach(async () => {
  await unmountAll();
  uninstallAlertTracking();
  jest.restoreAllMocks();
});

function byTestID(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => node.props.testID === testID);
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

function textInput(root: ReactTestInstance): ReactTestInstance {
  return at(
    root.findAll((node) => node.props.testID === 'tapline-alert-input' && typeof node.props.onChangeText === 'function'),
    0,
  );
}

function pressable(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID && typeof node.props.onPress === 'function');
  if (found.length === 0) throw new Error(`no pressable ${testID}`);
  return at(found, 0);
}

async function press(root: ReactTestInstance, testID: string): Promise<void> {
  const node = pressable(root, testID);
  await act(async () => {
    node.props.onPress();
  });
}

function wrappedButtons(spy: jest.SpyInstance<void, AlertArgs>): NonNullable<AlertArgs[2]> {
  const buttons = at(spy.mock.calls, 0)[2];
  if (!buttons) throw new Error('original got no buttons');
  return buttons;
}

describe('tracking (standIn false)', () => {
  it('records title, message and buttons and passes wrapped buttons to the original', () => {
    installAlertTracking();
    const onDelete = jest.fn();
    Alert.alert('Delete?', 'This cannot be undone', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);

    const open = openAlerts();
    expect(open).toHaveLength(1);
    expect(at(open, 0)).toMatchObject({
      kind: 'alert',
      title: 'Delete?',
      message: 'This cannot be undone',
      buttons: [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive' },
      ],
      standIn: false,
    });
    expect(typeof at(open, 0).id).toBe('number');
    expect(typeof at(open, 0).at).toBe('number');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = at(alertSpy.mock.calls, 0);
    expect(title).toBe('Delete?');
    expect(message).toBe('This cannot be undone');
    expect(buttons).toHaveLength(2);
    expect(buttons?.[1]?.text).toBe('Delete');
    expect(buttons?.[1]?.style).toBe('destructive');
    expect(buttons?.[1]?.onPress).not.toBe(onDelete);
  });

  it('closes the alert and calls the app handler with its arguments when a wrapped onPress runs', () => {
    installAlertTracking();
    const onYes = jest.fn();
    Alert.alert('Sure?', undefined, [{ text: 'Yes', onPress: onYes }, { text: 'No' }]);
    const buttons = wrappedButtons(alertSpy);
    expect(openAlerts()).toHaveLength(1);

    at(buttons, 0).onPress?.('extra');
    expect(onYes).toHaveBeenCalledWith('extra');
    expect(openAlerts()).toHaveLength(0);
  });

  it('closes on a button without an app handler', () => {
    installAlertTracking();
    Alert.alert('Sure?', undefined, [{ text: 'No' }]);
    at(wrappedButtons(alertSpy), 0).onPress?.();
    expect(openAlerts()).toHaveLength(0);
  });

  it('records a single OK button when there are none, and closes on it', () => {
    installAlertTracking();
    Alert.alert('Saved');
    expect(at(openAlerts(), 0)).toMatchObject({
      title: 'Saved',
      message: null,
      buttons: [{ text: 'OK', style: 'default' }],
    });
    const buttons = wrappedButtons(alertSpy);
    expect(buttons).toHaveLength(1);
    expect(at(buttons, 0).text).toBe('OK');
    at(buttons, 0).onPress?.();
    expect(openAlerts()).toHaveLength(0);
  });

  it('closes on options.onDismiss and still calls the app onDismiss', () => {
    installAlertTracking();
    const onDismiss = jest.fn();
    Alert.alert('Hi', 'there', [{ text: 'OK' }], { cancelable: true, onDismiss });
    const options = at(alertSpy.mock.calls, 0)[3];
    expect(options?.cancelable).toBe(true);
    options?.onDismiss?.();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(openAlerts()).toHaveLength(0);
  });

  it('lists open alerts oldest first', () => {
    installAlertTracking();
    Alert.alert('first');
    Alert.alert('second');
    expect(openAlerts().map((alert) => alert.title)).toEqual(['first', 'second']);
  });

  it('records a prompt with a callback as its OK button and forwards the typed text', () => {
    installAlertTracking();
    const callback = jest.fn();
    Alert.prompt('Name', 'Who are you?', callback);
    expect(at(openAlerts(), 0)).toMatchObject({
      kind: 'prompt',
      title: 'Name',
      message: 'Who are you?',
      buttons: [{ text: 'OK', style: 'default' }],
      standIn: false,
    });
    const forwarded = at(promptSpy.mock.calls, 0)[2];
    expect(typeof forwarded).toBe('function');
    if (typeof forwarded === 'function') forwarded('Ada');
    expect(callback).toHaveBeenCalledWith('Ada');
    expect(openAlerts()).toHaveLength(0);
  });

  it('wraps prompt buttons', () => {
    installAlertTracking();
    const onSend = jest.fn();
    Alert.prompt('Reply', undefined, [{ text: 'Cancel', style: 'cancel' }, { text: 'Send', onPress: onSend }], 'plain-text');
    expect(at(openAlerts(), 0).buttons.map((button) => button.text)).toEqual(['Cancel', 'Send']);
    const forwarded = at(promptSpy.mock.calls, 0)[2];
    if (!Array.isArray(forwarded)) throw new Error('expected buttons');
    at(forwarded, 1).onPress?.('hello');
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(openAlerts()).toHaveLength(0);
  });

  it('does not record twice when the original alert delegates to Alert.prompt (iOS)', () => {
    alertSpy.mockImplementation((title, message, buttons) => {
      Alert.prompt(title, message, buttons, 'default');
    });
    installAlertTracking();
    Alert.alert('Once', 'only');
    expect(openAlerts()).toHaveLength(1);
    expect(at(openAlerts(), 0).kind).toBe('alert');
  });

  it('calls the original unchanged when recording fails', () => {
    installAlertTracking();
    const hostile = {
      get text(): string {
        throw new Error('boom');
      },
    };
    expect(() => Alert.alert('Odd', 'case', [hostile])).not.toThrow();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(at(alertSpy.mock.calls, 0)[2]?.[0]).toBe(hostile);
    expect(openAlerts()).toHaveLength(0);
  });

  it('does not set a wrapper component provider', () => {
    installAlertTracking();
    expect(wrapperSpy).not.toHaveBeenCalled();
  });
});

describe('install / uninstall', () => {
  it('is idempotent: installing twice records once and still reaches the first original', () => {
    installAlertTracking();
    const afterFirst = Alert.alert;
    installAlertTracking();
    expect(Alert.alert).toBe(afterFirst);
    Alert.alert('Twice?');
    expect(openAlerts()).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it('uninstall restores Alert.alert and Alert.prompt and clears the queue', () => {
    const originalAlert = Alert.alert;
    const originalPrompt = Alert.prompt;
    installAlertTracking();
    expect(Alert.alert).not.toBe(originalAlert);
    Alert.alert('Pending');
    uninstallAlertTracking();
    expect(Alert.alert).toBe(originalAlert);
    expect(Alert.prompt).toBe(originalPrompt);
    expect(openAlerts()).toHaveLength(0);
  });

  it('uninstall without install is harmless', () => {
    expect(() => uninstallAlertTracking()).not.toThrow();
  });
});

describe('stand-in (standIn true)', () => {
  it('registers a wrapper component provider', () => {
    installAlertTracking({ standIn: true });
    expect(wrapperSpy).toHaveBeenCalledTimes(1);
    const provider = wrapperSpy.mock.calls[0][0] as () => React.ComponentType<{ children?: React.ReactNode }>;
    expect(typeof provider).toBe('function');
    expect(typeof provider()).toBe('function');
  });

  it('the wrapper renders its children and a host', async () => {
    installAlertTracking({ standIn: true });
    const provider = wrapperSpy.mock.calls[0][0] as () => React.ComponentType<{ children?: React.ReactNode }>;
    const Wrapper = provider();
    Alert.alert('Inside wrapper', 'message');
    const renderer = await mount(
      <Wrapper>
        <View testID="app-content" />
      </Wrapper>,
    );
    expect(byTestID(renderer.root, 'app-content').length).toBeGreaterThan(0);
    expect(byTestID(renderer.root, 'tapline-alert').length).toBeGreaterThan(0);
  });

  it('does not call the original and queues the alert', () => {
    installAlertTracking({ standIn: true });
    Alert.alert('Hello', 'World', [{ text: 'OK' }]);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(openAlerts()).toHaveLength(1);
    expect(at(openAlerts(), 0)).toMatchObject({ title: 'Hello', message: 'World', standIn: true, kind: 'alert' });
  });

  it('shows title, message and buttons in the mounted host, and pressing a button answers it', async () => {
    installAlertTracking({ standIn: true });
    const renderer = await mount(<TaplineAlertHost />);
    expect(renderer.toJSON()).toBeNull();

    const onDelete = jest.fn();
    const onCancel = jest.fn();
    await act(async () => {
      Alert.alert('Delete item?', 'It will be gone', [
        { text: 'Cancel', style: 'cancel', onPress: onCancel },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ]);
    });

    expect(byTestID(renderer.root, 'tapline-alert').length).toBeGreaterThan(0);
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Delete item?');
    expect(json).toContain('It will be gone');
    expect(pressable(renderer.root, 'tapline-alert-button-0').props.accessibilityRole).toBe('button');
    expect(JSON.stringify(renderer.toJSON())).toContain('Cancel');
    expect(JSON.stringify(renderer.toJSON())).toContain('Delete');
    expect(byTestID(renderer.root, 'tapline-alert-input')).toHaveLength(0);

    await press(renderer.root, 'tapline-alert-button-1');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(byTestID(renderer.root, 'tapline-alert')).toHaveLength(0);
    expect(renderer.toJSON()).toBeNull();
    expect(openAlerts()).toHaveLength(0);
  });

  it('shows the oldest alert first, then the next', async () => {
    installAlertTracking({ standIn: true });
    const renderer = await mount(<TaplineAlertHost />);
    await act(async () => {
      Alert.alert('First', undefined, [{ text: 'Next' }]);
      Alert.alert('Second', undefined, [{ text: 'Done' }]);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('First');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Second');
    await press(renderer.root, 'tapline-alert-button-0');
    expect(JSON.stringify(renderer.toJSON())).toContain('Second');
    await press(renderer.root, 'tapline-alert-button-0');
    expect(renderer.toJSON()).toBeNull();
  });

  it('gives a button-less alert an OK button', async () => {
    installAlertTracking({ standIn: true });
    const renderer = await mount(<TaplineAlertHost />);
    await act(async () => {
      Alert.alert('Saved');
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('OK');
    await press(renderer.root, 'tapline-alert-button-0');
    expect(openAlerts()).toHaveLength(0);
  });

  it('only the first mounted host renders', async () => {
    installAlertTracking({ standIn: true });
    const first = await mount(<TaplineAlertHost />);
    const second = await mount(<TaplineAlertHost />);
    await act(async () => {
      Alert.alert('Only once', undefined, [{ text: 'OK' }]);
    });
    expect(byTestID(first.root, 'tapline-alert').length).toBeGreaterThan(0);
    expect(second.toJSON()).toBeNull();
    expect(byTestID(second.root, 'tapline-alert')).toHaveLength(0);
  });

  it('a later host takes over when the first unmounts', async () => {
    installAlertTracking({ standIn: true });
    const first = await mount(<TaplineAlertHost />);
    const second = await mount(<TaplineAlertHost />);
    await act(async () => {
      Alert.alert('Handover', undefined, [{ text: 'OK' }]);
    });
    await act(async () => {
      first.unmount();
    });
    expect(byTestID(second.root, 'tapline-alert').length).toBeGreaterThan(0);
  });

  it('a prompt shows an input and passes the typed text to the handler', async () => {
    installAlertTracking({ standIn: true });
    const renderer = await mount(<TaplineAlertHost />);
    const onSave = jest.fn();
    await act(async () => {
      Alert.prompt('Rename', 'New name?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: onSave },
      ]);
    });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(at(openAlerts(), 0)).toMatchObject({ kind: 'prompt', standIn: true });

    const input = textInput(renderer.root);
    await act(async () => {
      input.props.onChangeText('Ada');
    });
    await press(renderer.root, 'tapline-alert-button-1');
    expect(onSave).toHaveBeenCalledWith('Ada');
    expect(openAlerts()).toHaveLength(0);
  });

  it('a prompt with a callback passes the typed text to it', async () => {
    installAlertTracking({ standIn: true });
    const renderer = await mount(<TaplineAlertHost />);
    const callback = jest.fn();
    await act(async () => {
      Alert.prompt('Code', undefined, callback);
    });
    const input = textInput(renderer.root);
    await act(async () => {
      input.props.onChangeText('1234');
    });
    await press(renderer.root, 'tapline-alert-button-0');
    expect(callback).toHaveBeenCalledWith('1234');
  });

  it('uninstall restores Alert.alert, clears the queue and stops the host rendering', async () => {
    const originalAlert = Alert.alert;
    installAlertTracking({ standIn: true });
    const renderer = await mount(<TaplineAlertHost />);
    await act(async () => {
      Alert.alert('Pending');
    });
    expect(byTestID(renderer.root, 'tapline-alert').length).toBeGreaterThan(0);
    await act(async () => {
      uninstallAlertTracking();
    });
    expect(Alert.alert).toBe(originalAlert);
    expect(openAlerts()).toHaveLength(0);
    expect(renderer.toJSON()).toBeNull();
  });

  it('install in stand-in mode twice sets the provider once', () => {
    installAlertTracking({ standIn: true });
    installAlertTracking({ standIn: true });
    expect(wrapperSpy).toHaveBeenCalledTimes(1);
  });
});
