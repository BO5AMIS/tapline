import { TaplineAgent, type AgentDeps, type AgentOptions, type LinkingLike } from '../src/agent';
import type { WebSocketLike } from '../src/client';
import { memoryStorage, type TaplineStorage } from '../src/storage';
import type { DeviceInfo } from '../src/types';

class MockSocket implements WebSocketLike {
  static instances: MockSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  get hello(): Record<string, unknown> | undefined {
    const first = this.sent[0];
    return first === undefined ? undefined : (JSON.parse(first) as Record<string, unknown>);
  }

  open(): void {
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code = 1006): void {
    this.onclose?.({ code });
  }
}

class FakeLinking implements LinkingLike {
  initial: string | null = null;
  private listeners: Array<(event: { url: string }) => void> = [];

  getInitialURL(): Promise<string | null> {
    return Promise.resolve(this.initial);
  }

  addEventListener(_type: 'url', listener: (event: { url: string }) => void): { remove(): void } {
    this.listeners.push(listener);
    return {
      remove: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }

  get listening(): number {
    return this.listeners.length;
  }

  open(url: string): void {
    for (const listener of this.listeners) listener({ url });
  }
}

const DEVICE: DeviceInfo = { platform: 'ios', osVersion: '26.1' };
const LINK = 'demo://tapline/pair?url=ws%3A%2F%2F100.64.0.1%3A7211%2F&code=abc-123&name=Dev%20PC';
const SAVED = { url: 'ws://100.64.0.9:7210/', token: 'old-token', name: 'Old PC' };

interface Harness {
  agent: TaplineAgent;
  linking: FakeLinking;
  storage: TaplineStorage;
  prompts: string[];
  notes: string[];
  answer: { value: boolean };
}

function makeAgent(storage: TaplineStorage = memoryStorage(), options: AgentOptions = {}): Harness {
  const linking = new FakeLinking();
  const prompts: string[] = [];
  const notes: string[] = [];
  const answer = { value: true };
  const deps: AgentDeps = {
    storage,
    linking,
    confirm: (title, message) => {
      prompts.push(`${title}\n${message}`);
      return Promise.resolve(answer.value);
    },
    notify: (_title, message) => notes.push(message),
    clientDeps: { WebSocketCtor: MockSocket, device: DEVICE, capabilities: ['tree'], methods: {}, log: () => {} },
    log: () => {},
  };
  return { agent: new TaplineAgent({ app: { name: 'Demo', id: 'com.demo' }, ...options }, deps), linking, storage, prompts, notes, answer };
}

function last(): MockSocket {
  const socket = MockSocket.instances[MockSocket.instances.length - 1];
  if (!socket) throw new Error('no socket yet');
  return socket;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const agents: TaplineAgent[] = [];
function track(harness: Harness): Harness {
  agents.push(harness.agent);
  return harness;
}

beforeEach(() => {
  MockSocket.instances = [];
});

afterEach(() => {
  for (const agent of agents.splice(0)) agent.stop();
});

describe('TaplineAgent', () => {
  test('stays idle until paired: no saved computer and no link means no connection', async () => {
    const { agent } = track(makeAgent());
    await agent.start();
    expect(MockSocket.instances).toHaveLength(0);
  });

  test('asks before connecting to the computer in a pairing link, naming it and its address', async () => {
    const { agent, linking, prompts } = track(makeAgent());
    linking.initial = LINK;
    await agent.start();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Dev PC');
    expect(prompts[0]).toContain('100.64.0.1');
    expect(last().url).toBe('ws://100.64.0.1:7211/');
    last().open();
    expect(last().hello).toMatchObject({ pairCode: 'abc-123', app: { id: 'com.demo' } });
    expect(last().hello).not.toHaveProperty('token');
    expect(String((last().hello?.device as Record<string, unknown>).id)).toMatch(/^[0-9a-f]{12}$/);
  });

  test('does nothing when the user cancels', async () => {
    const { agent, linking, storage, answer } = track(makeAgent());
    answer.value = false;
    linking.initial = LINK;
    await agent.start();
    expect(MockSocket.instances).toHaveLength(0);
    expect(await storage.getItem('tapline.pairing')).toBeNull();
  });

  test('remembers the computer once the host hands over its token, and reconnects to it on the next launch', async () => {
    const storage = memoryStorage();
    const first = track(makeAgent(storage));
    first.linking.initial = LINK;
    await first.agent.start();
    last().open();
    last().receive({ type: 'welcome', protocol: 1, session: 's-1', token: 'host-token' });
    await flush();
    first.agent.stop();

    const second = track(makeAgent(storage));
    await second.agent.start();
    expect(second.prompts).toHaveLength(0);
    expect(last().url).toBe('ws://100.64.0.1:7211/');
    last().open();
    expect(last().hello).toMatchObject({ token: 'host-token' });
    expect(last().hello).not.toHaveProperty('pairCode');
  });

  test('a pairing link that arrives while the app is open works too', async () => {
    const { agent, linking, prompts } = track(makeAgent());
    await agent.start();
    linking.open(LINK);
    await flush();
    expect(prompts).toHaveLength(1);
    expect(last().url).toBe('ws://100.64.0.1:7211/');
  });

  test('ignores links that are not Tapline links', async () => {
    const { agent, linking, prompts } = track(makeAgent());
    await agent.start();
    linking.open('demo://settings');
    await flush();
    expect(prompts).toHaveLength(0);
    expect(MockSocket.instances).toHaveLength(0);
  });

  test('an expired code: says so and goes back to the computer it was paired with', async () => {
    const storage = memoryStorage();
    await storage.setItem('tapline.pairing', JSON.stringify(SAVED));
    const { agent, linking, notes } = track(makeAgent(storage));
    await agent.start();
    const old = last();
    expect(old.url).toBe(SAVED.url);

    linking.open(LINK);
    await flush();
    expect(old.closed).toBe(true);
    last().open();
    last().drop(4004);
    await flush();
    expect(notes.some((note) => note.includes('expired'))).toBe(true);
    expect(last().url).toBe(SAVED.url);
    last().open();
    expect(last().hello).toMatchObject({ token: 'old-token' });
    expect(JSON.parse((await storage.getItem('tapline.pairing')) ?? '{}')).toEqual(SAVED);
  });

  test('Expo Go reloads with the pairing link it was opened by: a code this phone already used is not asked about again', async () => {
    const storage = memoryStorage();
    const first = track(makeAgent(storage));
    first.linking.initial = LINK;
    await first.agent.start();
    last().open();
    last().receive({ type: 'welcome', protocol: 1, session: 's-1', token: 'host-token' });
    await flush();
    first.agent.stop();

    // The reload: a new JavaScript start, the same launch link.
    const second = track(makeAgent(storage));
    second.linking.initial = LINK;
    await second.agent.start();
    await flush();
    expect(second.prompts).toHaveLength(0);
    expect(second.notes).toHaveLength(0);
    expect(last().url).toBe('ws://100.64.0.1:7211/');
    last().open();
    expect(last().hello).toMatchObject({ token: 'host-token' });
  });

  test('a launch forget link when nothing is paired stays quiet (a reload after forgetting)', async () => {
    const { agent, linking, notes } = track(makeAgent());
    linking.initial = 'demo://tapline/forget';
    await agent.start();
    expect(notes).toHaveLength(0);
    linking.open('demo://tapline/forget');
    await flush();
    expect(notes).toEqual(['This app was not paired with a computer.']);
  });

  test("an expired code's note says to open a new link, not only to scan", async () => {
    const { agent, linking, notes } = track(makeAgent());
    await agent.start();
    linking.open(LINK);
    await flush();
    last().open();
    last().drop(4004);
    await flush();
    expect(notes.at(-1)).toMatch(/Make a new one on the computer and scan or open it again\.$/);
  });

  test('the forget link disconnects and forgets the computer', async () => {
    const storage = memoryStorage();
    await storage.setItem('tapline.pairing', JSON.stringify(SAVED));
    const { agent, linking, notes } = track(makeAgent(storage));
    await agent.start();
    const socket = last();
    linking.open('demo://tapline/forget');
    await flush();
    expect(socket.closed).toBe(true);
    expect(await storage.getItem('tapline.pairing')).toBeNull();
    expect(notes.some((note) => note.includes('Old PC'))).toBe(true);
    expect(MockSocket.instances).toHaveLength(1);
  });

  test('keeps the same install id across launches, and a different install gets another', async () => {
    const storage = memoryStorage();
    await storage.setItem('tapline.pairing', JSON.stringify(SAVED));
    const idOf = async (store: TaplineStorage): Promise<unknown> => {
      const harness = track(makeAgent(store));
      await harness.agent.start();
      last().open();
      const id = (last().hello?.device as Record<string, unknown>).id;
      harness.agent.stop();
      return id;
    };
    const first = await idOf(storage);
    expect(await idOf(storage)).toBe(first);
    const other = memoryStorage();
    await other.setItem('tapline.pairing', JSON.stringify(SAVED));
    expect(await idOf(other)).not.toBe(first);
  });

  test('a direct url and token connect without pairing', async () => {
    const { agent } = track(makeAgent(memoryStorage(), { direct: { url: 'ws://127.0.0.1:7210/', token: 'direct-token' } }));
    await agent.start();
    last().open();
    expect(last().url).toBe('ws://127.0.0.1:7210/');
    expect(last().hello).toMatchObject({ token: 'direct-token' });
  });

  test('stop removes the link listener and closes the socket', async () => {
    const storage = memoryStorage();
    await storage.setItem('tapline.pairing', JSON.stringify(SAVED));
    const { agent, linking } = track(makeAgent(storage));
    await agent.start();
    expect(linking.listening).toBe(1);
    agent.stop();
    expect(linking.listening).toBe(0);
    expect(last().closed).toBe(true);
  });

  test('stop during start leaves nothing running', async () => {
    const storage = memoryStorage();
    await storage.setItem('tapline.pairing', JSON.stringify(SAVED));
    const { agent } = track(makeAgent(storage));
    const starting = agent.start();
    agent.stop();
    await starting;
    await flush();
    expect(MockSocket.instances).toHaveLength(0);
  });

  test('warns when the computer is outside Tailscale and the local network', async () => {
    const outside = track(makeAgent());
    outside.linking.initial = 'demo://tapline/pair?url=ws%3A%2F%2F203.0.113.5%3A7210%2F&code=c1&name=PC';
    await outside.agent.start();
    expect(outside.prompts[0]).toContain('not on your Tailscale network');

    const inside = track(makeAgent());
    inside.linking.initial = LINK;
    await inside.agent.start();
    expect(inside.prompts[0]).not.toContain('not on your Tailscale network');
  });

  test('the same pairing link delivered twice asks once', async () => {
    const { agent, linking, prompts } = track(makeAgent());
    linking.initial = LINK;
    await agent.start();
    linking.open(LINK);
    await flush();
    expect(prompts).toHaveLength(1);
    expect(MockSocket.instances).toHaveLength(1);
  });

  test('forgetting right after pairing stays forgotten, even with a slow keychain', async () => {
    const fast = memoryStorage();
    const slow: TaplineStorage = {
      getItem: (key) => fast.getItem(key),
      setItem: (key, value) => new Promise((resolve) => setTimeout(() => resolve(fast.setItem(key, value)), 20)),
      removeItem: (key) => fast.removeItem(key),
    };
    const { agent, linking } = track(makeAgent(slow));
    linking.initial = LINK;
    await agent.start();
    last().open();
    last().receive({ type: 'welcome', protocol: 1, session: 's-1', token: 'host-token' });
    linking.open('demo://tapline/forget');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await fast.getItem('tapline.pairing')).toBeNull();
  });

  test('a rejected code in direct mode goes back to the direct connection', async () => {
    const { agent, linking } = track(makeAgent(memoryStorage(), { direct: { url: 'ws://127.0.0.1:7210/', token: 'direct-token' } }));
    await agent.start();
    linking.open(LINK);
    await flush();
    last().open();
    last().drop(4004);
    await flush();
    expect(last().url).toBe('ws://127.0.0.1:7210/');
    last().open();
    expect(last().hello).toMatchObject({ token: 'direct-token' });
  });

  test('a computer that no longer accepts this phone (4001): says so', async () => {
    const storage = memoryStorage();
    await storage.setItem('tapline.pairing', JSON.stringify(SAVED));
    const { agent, notes } = track(makeAgent(storage));
    await agent.start();
    last().open();
    last().drop(4001);
    await flush();
    expect(notes.some((note) => note.includes('Old PC') && note.includes('pair'))).toBe(true);
  });

  test('a broken saved pairing is ignored instead of crashing', async () => {
    const storage = memoryStorage();
    await storage.setItem('tapline.pairing', '{not json');
    const { agent } = track(makeAgent(storage));
    await expect(agent.start()).resolves.toBeUndefined();
    expect(MockSocket.instances).toHaveLength(0);
  });
});
