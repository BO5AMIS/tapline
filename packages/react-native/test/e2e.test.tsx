import { SAMPLE_FRAMES, SampleScreen, makeSpies, mount, unmountAll, useFrames, type Spies } from './helpers';
import React from 'react';
import { Dimensions, PixelRatio } from 'react-native';
import { act } from 'react-test-renderer';
import { configureActions } from '../src/actions';
import { TaplineClient, type WebSocketLike } from '../src/client';
import { resetRefs, setMeasurer } from '../src/inspect';
import { uninstallLogs } from '../src/logs';
import type { TreeResult } from '../src/types';

/** The real method table driven over the wire format, against a rendered screen. */
class Socket implements WebSocketLike {
  static last: Socket | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  constructor(readonly url: string) {
    Socket.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {}
}

let spies: Spies;
let client: TaplineClient;
let nextId = 1;

async function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const socket = Socket.last;
  if (!socket) throw new Error('not connected');
  const id = nextId++;
  let found: Record<string, unknown> | undefined;
  await act(async () => {
    socket.onmessage?.({ data: JSON.stringify({ type: 'request', id, method, params }) });
    for (let i = 0; i < 200 && !found; i++) {
      found = socket.sent.find((m) => m.type === 'response' && m.id === id);
      if (!found) await new Promise<void>((resolve) => setTimeout(() => resolve(), 5));
    }
  });
  if (!found) throw new Error(`no response to ${method}`);
  return found;
}

beforeAll(() => configureActions({ quietMs: 0, capMs: 0 }));

beforeEach(async () => {
  resetRefs();
  nextId = 1;
  spies = makeSpies();
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
  await mount(<SampleScreen spies={spies} />);
  useFrames(SAMPLE_FRAMES);
  client = new TaplineClient({ url: 'ws://host:7210', token: 't' }, { WebSocketCtor: Socket, log: () => {} });
  client.start();
  Socket.last?.onopen?.({});
  Socket.last?.onmessage?.({ data: JSON.stringify({ type: 'welcome', protocol: 1, session: 's-1' }) });
});

afterEach(async () => {
  client.stop();
  uninstallLogs();
  await unmountAll();
  setMeasurer(null);
  jest.restoreAllMocks();
});

test('hello advertises the default capabilities', () => {
  const hello = Socket.last?.sent[0];
  expect(hello).toMatchObject({ type: 'hello', protocol: 1, token: 't' });
  const capabilities = (hello?.capabilities ?? []) as string[];
  expect(capabilities).toEqual(expect.arrayContaining(['tree', 'press', 'longPress', 'type', 'scroll', 'toggle', 'openURL', 'logs']));
  expect(capabilities).not.toContain('screenshot'); // react-native-view-shot is not installed in this test
});

test('tree then press by ref, then type, then read the result back', async () => {
  const treeResponse = await call('tree');
  expect(treeResponse.ok).toBe(true);
  const { elements } = treeResponse.result as TreeResult;
  const login = elements.find((e) => e.testID === 'login-button');
  expect(login?.actions).toEqual(['press', 'longPress']);

  const pressed = await call('press', { target: { ref: login?.ref } });
  expect(pressed).toMatchObject({ ok: true, result: { element: { testID: 'login-button' } } });
  expect(spies.onLogin).toHaveBeenCalledTimes(1);

  const typed = await call('type', { target: { label: 'does not exist' }, text: 'x' });
  expect(typed).toMatchObject({ ok: false, error: { code: 'not_found' } });

  const typedOk = await call('type', { target: { testID: 'name-input' }, text: 'Mo', submit: true });
  expect(typedOk).toMatchObject({ ok: true, result: { value: 'Mo' } });
  expect(spies.onSubmit).toHaveBeenCalledTimes(1);

  const after = (await call('tree')).result as TreeResult;
  expect(after.elements.find((e) => e.testID === 'state-line')?.text).toBe('name=Mo on=false');
});

test('an ambiguous target comes back with refs the host can reuse', async () => {
  const response = await call('press', { target: { text: 'Delete' } });
  expect(response).toMatchObject({ ok: false, error: { code: 'ambiguous', refs: [expect.any(String), expect.any(String)] } });
  const refs = (response.error as { refs: string[] }).refs;
  const second = await call('press', { target: { ref: refs[1] } });
  expect(second.ok).toBe(true);
  expect(spies.onDelete).toHaveBeenCalledWith(2);
});

test('toggle and logs over the wire', async () => {
  const toggled = await call('toggle', { target: { testID: 'notify-switch' } });
  expect(toggled).toMatchObject({ ok: true, result: { value: true } });
  const logs = await call('logs', {});
  expect(logs).toMatchObject({ ok: true, result: { entries: expect.any(Array) } });
});

test('screenshot without react-native-view-shot answers unsupported', async () => {
  expect(await call('screenshot')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
});
