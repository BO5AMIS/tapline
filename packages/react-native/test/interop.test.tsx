/// <reference types="node" />
/**
 * Interop: the real host (@tapline/host's CLI, `tapline mcp`, as a child process) and
 * the real in-app agent (TaplineClient + the inspector over a rendered screen) talking
 * over a real WebSocket, driven the way an agent drives them: MCP tool calls over the
 * host's stdio. Needs the host built (`npm run build -w @tapline/host`); skipped otherwise.
 */
// First, as in an app's entry file: the hook must exist before React Native loads.
import '../src/register';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { act } from 'react-test-renderer';
import { TaplineAgent, type LinkingLike } from '../src/agent';
import type { WebSocketCtor } from '../src/client';
import { memoryStorage } from '../src/storage';
import { frame, makeSpies, mount, SampleScreen, unmountAll, useFrames } from './helpers';

const HOST_CLI = path.resolve(__dirname, '../../host/dist/cli.js');
const hostBuilt = fs.existsSync(HOST_CLI);
const describeIfBuilt = hostBuilt ? describe : describe.skip;

jest.setTimeout(30000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** A minimal MCP client over the child's stdio (newline-delimited JSON-RPC). */
class McpClient {
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, (message: Record<string, unknown>) => void>();

  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line) as Record<string, unknown>;
          const id = message.id;
          if (typeof id === 'number') this.pending.get(id)?.(message);
        }
        newline = this.buffer.indexOf('\n');
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 15000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve((message.result ?? {}) as Record<string, unknown>);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    // Tools run app actions that update React state: let them settle inside act().
    let result: ToolResult = { content: [] };
    await act(async () => {
      result = (await this.request('tools/call', { name, arguments: args })) as unknown as ToolResult;
    });
    const text = result.content.map((part) => part.text ?? `[${part.type}]`).join('\n');
    return { text, isError: result.isError === true };
  }
}

describeIfBuilt('host <-> app over a real WebSocket, paired and driven through MCP', () => {
  let home: string;
  let child: ChildProcessWithoutNullStreams;
  let mcp: McpClient;
  let agent: TaplineAgent;
  let pairText = '';
  const storage = memoryStorage(); // the phone's keychain, across launches
  const spies = makeSpies();

  /** One launch of the app: `initial` is the link that opened it, if any. */
  function launch(initial: string | null): TaplineAgent {
    const linking: LinkingLike = {
      getInitialURL: () => Promise.resolve(initial),
      addEventListener: () => ({ remove: () => undefined }),
    };
    // The real `ws` client stands in for React Native's global WebSocket.
    const WebSocketImpl = require('ws') as WebSocketCtor;
    return new TaplineAgent(
      { app: { name: 'Interop', id: 'dev.tapline.interop', version: '1.0.0', build: '1' } },
      {
        storage,
        linking,
        confirm: () => Promise.resolve(true), // the user taps Connect
        notify: () => undefined,
        clientDeps: { WebSocketCtor: WebSocketImpl, device: { platform: 'ios', osVersion: '26.1' }, log: () => undefined },
        log: () => undefined,
      },
    );
  }

  async function waitForApp(): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const apps = await mcp.call('apps');
      if (apps.text.includes('Interop')) return apps.text;
      await sleep(100);
    }
    throw new Error('the app never connected to the host');
  }

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tapline-interop-'));
    const port = await freePort();
    child = spawn(process.execPath, [HOST_CLI, 'mcp', '--port', String(port), '--host', '127.0.0.1'], {
      env: { ...process.env, TAPLINE_HOME: home },
    });
    child.stderr.setEncoding('utf8');
    mcp = new McpClient(child);
    await mcp.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'tapline-interop-test', version: '0.0.0' },
    });
    mcp.notify('notifications/initialized');

    await mount(<SampleScreen spies={spies} />);
    useFrames({
      'login-button': frame(20, 100, 200, 44),
      'name-input': frame(20, 200, 300, 40),
      'main-scroll': frame(0, 0, 400, 800),
    });

    // The agent asks for a pairing link; the phone's camera opens the app with it.
    pairText = (await mcp.call('pair', { scheme: 'interop' })).text;
    const link = /interop:\/\/tapline\/pair\?\S+/.exec(pairText)?.[0];
    if (link === undefined) throw new Error(`no pairing link in: ${pairText}`);
    agent = launch(link);
    await agent.start();
    await waitForApp();
  });

  afterAll(async () => {
    agent?.stop();
    child?.kill();
    await unmountAll();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('pair returns the link, a QR image and the forget link', () => {
    expect(pairText).toContain('[image]');
    expect(pairText).toContain('interop://tapline/forget');
    expect(pairText).toMatch(/url=ws%3A%2F%2F127\.0\.0\.1%3A\d+%2F/);
  });

  test('apps lists the paired app with its install id', async () => {
    const { text, isError } = await mcp.call('apps');
    expect(isError).toBe(false);
    expect(text).toContain('Interop');
    expect(text).toContain('dev.tapline.interop');
    expect(text).toMatch(/ios 26\.1, install [0-9a-f]{6}/);
  });

  test('look returns the screen as elements', async () => {
    const { text, isError } = await mcp.call('look', { screenshot: false });
    expect(isError).toBe(false);
    expect(text).toContain('login-button');
    expect(text).toContain('Log in');
    expect(text).toContain('name-input');
  });

  test('press by testID reaches the app', async () => {
    const { isError } = await mcp.call('press', { target: { testID: 'login-button' }, look: false });
    expect(isError).toBe(false);
    expect(spies.onLogin).toHaveBeenCalledTimes(1);
  });

  test('type_text updates a controlled input, and look shows it', async () => {
    const typed = await mcp.call('type_text', { text: 'Mo', target: { testID: 'name-input' }, look: false });
    expect(typed.isError).toBe(false);
    const { text } = await mcp.call('look', { screenshot: false });
    expect(text).toMatch(/name-input[^\n]*Mo/);
  });

  test('errors come back as tool errors with the code', async () => {
    const { text, isError } = await mcp.call('press', { target: { testID: 'no-such-thing' }, look: false });
    expect(isError).toBe(true);
    expect(text).toContain('not_found');
  });

  test('on the next launch the app reconnects by itself, with no new code', async () => {
    // Let the list's batched re-render from the earlier typing finish inside act().
    await act(async () => {
      await sleep(200);
    });
    agent.stop();
    for (let i = 0; i < 50 && (await mcp.call('apps')).text.includes('Interop'); i++) await sleep(100);
    agent = launch(null);
    await agent.start();
    const text = await waitForApp();
    expect(text).toContain('dev.tapline.interop');
    const { isError } = await mcp.call('press', { target: { testID: 'login-button' }, look: false });
    expect(isError).toBe(false);
  });
});
