import { OFFER_PAIR_TIMEOUT_MS, PAIRING_KEY, TaplineAgent, isLocalNetworkHost, type AgentDeps, type DevOffer, type LinkingLike, type OfferSource } from '../src/agent';
import type { WebSocketLike } from '../src/client';
import { memoryStorage, type TaplineStorage } from '../src/storage';

// Zero-QR pairing (Tapline 1.1): a development build asks to connect to the computer its code comes from.

class MockSocket implements WebSocketLike {
  static instances: MockSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

const linking: LinkingLike = {
  getInitialURL: () => Promise.resolve(null),
  addEventListener: () => ({ remove: () => undefined }),
};

interface Rig {
  agent: TaplineAgent;
  prompts: string[];
  fetched: Array<{ host: string; port: number }>;
  tick: () => Promise<void>;
  answer: { value: boolean };
  /** Fires the pairing bound's timer, if one is set. */
  fireBound: () => Promise<void>;
  /** Makes confirm wait until release() is called. */
  hold: { release: ((agreed: boolean) => void) | null; on: boolean };
}

function rig(host: string | null, offers: Record<number, DevOffer>, active = true, metroPort = 8081, storage: TaplineStorage = memoryStorage()): Rig {
  const prompts: string[] = [];
  const fetched: Array<{ host: string; port: number }> = [];
  const answer = { value: true };
  let pending: (() => void) | null = null;
  let boundPending: (() => void) | null = null;
  const hold: Rig['hold'] = { release: null, on: false };
  const source: OfferSource = {
    devServer: () => (host === null ? null : { host, port: metroPort }),
    fetchOffer: (h, port) => {
      fetched.push({ host: h, port });
      return Promise.resolve(offers[port] ?? null);
    },
    active: () => active,
    setTimeout: (fn, ms) => {
      if (ms === OFFER_PAIR_TIMEOUT_MS) {
        boundPending = fn;
        return 2;
      }
      pending = fn;
      return 1;
    },
    clearTimeout: (handle) => {
      if (handle === 2) boundPending = null;
      else pending = null;
    },
  };
  const deps: AgentDeps = {
    storage,
    linking,
    confirm: (title, message) => {
      prompts.push(`${title}\n${message}`);
      if (hold.on) return new Promise<boolean>((resolve) => (hold.release = resolve));
      return Promise.resolve(answer.value);
    },
    notify: () => undefined,
    clientDeps: { WebSocketCtor: MockSocket, device: { platform: 'ios', osVersion: '26.1' }, capabilities: ['tree'], methods: {}, log: () => {} },
    log: () => {},
    offers: source,
  };
  const agent = new TaplineAgent({ app: { name: 'Demo', id: 'com.demo' } }, deps);
  const tick = async (): Promise<void> => {
    const run = pending;
    pending = null;
    run?.();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const fireBound = async (): Promise<void> => {
    const run = boundPending;
    boundPending = null;
    run?.();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { agent, prompts, fetched, tick, answer, fireBound, hold };
}

beforeEach(() => {
  MockSocket.instances = [];
});

test('finds the offer on the Metro computer, asks once, and pairs with its code at Metro’s address', async () => {
  const { agent, prompts, fetched, tick } = rig('192.168.1.20', { 7211: { code: 'c-1', name: 'Dev PC' } });
  await agent.start();
  await tick();
  expect(fetched.map((f) => f.port)).toEqual([8081, 7210, 7211, 7212, 7213, 7214, 7215, 7216, 7217, 7218, 7219]);
  expect(fetched.every((f) => f.host === '192.168.1.20')).toBe(true);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('Dev PC (192.168.1.20), the computer this app’s code comes from'.replace('’', "'"));
  const socket = MockSocket.instances[0];
  expect(socket?.url).toBe('ws://192.168.1.20:7211/');
  socket?.onopen?.({});
  expect(JSON.parse(socket?.sent[0] ?? '{}')).toMatchObject({ type: 'hello', pairCode: 'c-1' });
  // the same offer isn't asked about again
  await tick();
  expect(prompts).toHaveLength(1);
  agent.stop();
});

test('a declined offer is not asked again; nothing connects', async () => {
  const { agent, prompts, tick, answer } = rig('192.168.1.20', { 7210: { code: 'c-2', name: 'Dev PC' } });
  answer.value = false;
  await agent.start();
  await tick();
  await tick();
  expect(prompts).toHaveLength(1);
  expect(MockSocket.instances).toHaveLength(0);
  agent.stop();
});

test('never looks when the code comes from Tailscale, the internet or no server, or while in the background', async () => {
  for (const host of ['100.101.102.103', '203.0.113.5', null]) {
    const { agent, fetched, tick } = rig(host, { 7210: { code: 'x', name: 'PC' } });
    await agent.start();
    await tick();
    expect(fetched).toHaveLength(0);
    agent.stop();
  }
  const away = rig('192.168.1.20', { 7210: { code: 'y', name: 'PC' } }, false);
  await away.agent.start();
  await away.tick();
  expect(away.fetched).toHaveLength(0);
  away.agent.stop();
});

test('takes the offer Metro passes on, and connects to the port it names', async () => {
  const { agent, prompts, fetched, tick } = rig('192.168.1.20', { 8081: { code: 'm-1', name: 'Dev PC', port: 19001 } });
  await agent.start();
  await tick();
  expect(fetched.map((f) => f.port)).toEqual([8081]);
  expect(prompts).toHaveLength(1);
  expect(MockSocket.instances[0]?.url).toBe('ws://192.168.1.20:19001/');
  agent.stop();
});

test('a saved pairing whose host is gone (another port now) no longer blocks the offer: the person is asked', async () => {
  // Found on the phone (2026-11-13): an app paired with a host that stopped kept retrying it and ignored new offers.
  const storage = memoryStorage();
  await storage.setItem(PAIRING_KEY, JSON.stringify({ url: 'ws://192.168.1.20:7210/', token: 't-old', name: 'Dev PC' }));
  const { agent, prompts, tick } = rig('192.168.1.20', { 8081: { code: 'm-2', name: 'Dev PC', port: 19001 } }, true, 8081, storage);
  try {
    await agent.start();
    expect(MockSocket.instances[0]?.url).toBe('ws://192.168.1.20:7210/'); // the old home is tried, and never answers
    await tick();
    expect(prompts).toHaveLength(1);
    expect(MockSocket.instances.at(-1)?.url).toBe('ws://192.168.1.20:19001/');
  } finally {
    agent.stop(); // a failure must not leave the old home's reconnect timer running
  }
});

test('a saved pairing whose host answers still blocks offers: nothing is asked', async () => {
  const storage = memoryStorage();
  await storage.setItem(PAIRING_KEY, JSON.stringify({ url: 'ws://192.168.1.20:7210/', token: 't-live', name: 'Dev PC' }));
  const { agent, prompts, fetched, tick } = rig('192.168.1.20', { 8081: { code: 'm-3', name: 'Dev PC', port: 19001 } }, true, 8081, storage);
  try {
    await agent.start();
    const home = MockSocket.instances[0];
    home?.onopen?.({});
    home?.onmessage?.({ data: JSON.stringify({ type: 'welcome' }) });
    await tick();
    expect(prompts).toHaveLength(0);
    expect(fetched).toHaveLength(0);
    expect(MockSocket.instances).toHaveLength(1);
  } finally {
    agent.stop();
  }
});

const OLD_HOME = { url: 'ws://192.168.1.20:7210/', token: 't-home', name: 'Dev PC' };
const OFFER = { 8081: { code: 'm-4', name: 'Dev PC', port: 19001 } };

function welcome(socket: MockSocket | undefined): void {
  socket?.onopen?.({});
  socket?.onmessage?.({ data: JSON.stringify({ type: 'welcome' }) });
}

test('an offer skipped because the home reconnected is asked about once the home is down again', async () => {
  const storage = memoryStorage();
  await storage.setItem(PAIRING_KEY, JSON.stringify(OLD_HOME));
  const { agent, prompts, tick } = rig('192.168.1.20', OFFER, true, 8081, storage);
  try {
    await agent.start();
    const home = MockSocket.instances[0];
    // The offer is found while the home is down and queued behind other pairing work; the home reconnects before it runs.
    type Internals = { chain: Promise<void> };
    const internals = agent as unknown as Internals;
    let open: () => void = () => undefined;
    internals.chain = new Promise<void>((resolve) => (open = resolve));
    void tick();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    welcome(home);
    open();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(0);
    home?.onclose?.({ code: 1006 }); // the home goes away again
    await tick();
    expect(prompts).toHaveLength(1);
    expect(MockSocket.instances.at(-1)?.url).toBe('ws://192.168.1.20:19001/');
  } finally {
    agent.stop();
  }
});

test('the home reconnects while the prompt is open: accepting does not replace it', async () => {
  const storage = memoryStorage();
  await storage.setItem(PAIRING_KEY, JSON.stringify(OLD_HOME));
  const { agent, prompts, tick, hold } = rig('192.168.1.20', OFFER, true, 8081, storage);
  hold.on = true;
  try {
    await agent.start();
    const home = MockSocket.instances[0];
    let stops = 0;
    if (home) home.close = () => void stops++;
    void tick();
    for (let i = 0; i < 10 && hold.release === null; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(1);
    welcome(home); // the home answers while the person is deciding
    hold.release?.(true);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(MockSocket.instances.some((s) => s.url === 'ws://192.168.1.20:19001/')).toBe(false);
    expect(MockSocket.instances).toHaveLength(1);
    expect(stops).toBe(0);
  } finally {
    agent.stop();
  }
});

test('an accepted offer whose host never answers falls back to the saved home after the bound', async () => {
  const storage = memoryStorage();
  await storage.setItem(PAIRING_KEY, JSON.stringify(OLD_HOME));
  const { agent, prompts, tick, fireBound } = rig('192.168.1.20', OFFER, true, 8081, storage);
  try {
    await agent.start();
    await tick();
    expect(prompts).toHaveLength(1);
    const offered = MockSocket.instances.at(-1);
    expect(offered?.url).toBe('ws://192.168.1.20:19001/'); // never answers
    const before = MockSocket.instances.length;
    await fireBound();
    expect(MockSocket.instances.length).toBeGreaterThan(before);
    expect(MockSocket.instances.at(-1)?.url).toBe(OLD_HOME.url);
    expect(JSON.parse((await storage.getItem(PAIRING_KEY)) ?? '{}')).toEqual(OLD_HOME);
  } finally {
    agent.stop();
  }
});

test('with no saved home, an offered host that never answers is dropped after the bound', async () => {
  const { agent, tick, fireBound } = rig('192.168.1.20', OFFER);
  try {
    await agent.start();
    await tick();
    const count = MockSocket.instances.length;
    await fireBound();
    expect(MockSocket.instances).toHaveLength(count); // nothing new connects
  } finally {
    agent.stop();
  }
});

test('local network hosts', () => {
  expect(isLocalNetworkHost('192.168.1.67')).toBe(true);
  expect(isLocalNetworkHost('10.0.0.4')).toBe(true);
  expect(isLocalNetworkHost('localhost')).toBe(true);
  expect(isLocalNetworkHost('100.64.1.1')).toBe(false);
  expect(isLocalNetworkHost('8.8.8.8')).toBe(false);
  expect(isLocalNetworkHost('abc.exp.direct')).toBe(false);
});
