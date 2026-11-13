import { Appearance } from 'react-native';
import { listCommands, registerTaplineCommand, resetCommands, runCommand } from '../src/commands';
import { TaplineError } from '../src/types';

async function failure(promise: Promise<unknown>): Promise<TaplineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TaplineError) return error;
    throw error;
  }
  throw new Error('expected a TaplineError');
}

afterEach(() => {
  resetCommands();
  jest.restoreAllMocks();
});

test('lists the built-in animations, appearance, network and settle commands and the app’s own, sorted by name', () => {
  registerTaplineCommand('signin', { description: 'Sign in as a test user', run: () => undefined });
  expect(listCommands()).toEqual([
    { name: 'animations', description: expect.stringContaining('fast') },
    { name: 'appearance', description: expect.stringContaining('dark') },
    { name: 'network', description: expect.stringContaining('offline') },
    { name: 'settle', description: expect.stringContaining('quiet') },
    { name: 'signin', description: 'Sign in as a test user' },
    { name: 'text_size', description: expect.stringContaining('size') },
  ]);
});

test('runs a command with its args and returns a JSON-safe result', async () => {
  const run = jest.fn(async (args: Record<string, unknown>) => ({ ok: true, code: args.code, later: () => 1, when: new Date(0) }));
  registerTaplineCommand('seed', { description: 'Switch language', run });
  const result = await runCommand({ name: 'seed', args: { code: 'ar' } });
  expect(run).toHaveBeenCalledWith({ code: 'ar' });
  expect(result).toEqual({ name: 'seed', result: { ok: true, code: 'ar', when: '1970-01-01T00:00:00.000Z' } });
});

test('an unknown command is not_found and names the ones there are', async () => {
  const error = await failure(runCommand({ name: 'nope' }));
  expect(error.code).toBe('not_found');
  expect(error.message).toContain('appearance');
});

test('a command that throws becomes an internal error with its message', async () => {
  registerTaplineCommand('boom', { description: 'Fails', run: () => { throw new Error('no test account'); } });
  const error = await failure(runCommand({ name: 'boom' }));
  expect(error.code).toBe('internal');
  expect(error.message).toContain('no test account');
});

test('bad params and bad names are rejected', async () => {
  expect((await failure(runCommand({}))).code).toBe('bad_params');
  expect((await failure(runCommand({ name: 'x', args: 'nope' }))).code).toBe('bad_params');
  expect(() => registerTaplineCommand('has space', { description: 'x', run: () => undefined })).toThrow();
});

test('registering returns an unregister function; registering a name again replaces it', async () => {
  const first = jest.fn(() => 'first');
  const second = jest.fn(() => 'second');
  registerTaplineCommand('seed', { description: 'v1', run: first });
  const unregister = registerTaplineCommand('seed', { description: 'v2', run: second });
  expect((await runCommand({ name: 'seed' })).result).toBe('second');
  unregister();
  expect(listCommands().some((c) => c.name === 'seed')).toBe(false);
});

test('appearance sets the colour scheme, and system resets it', async () => {
  const set = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
  await runCommand({ name: 'appearance', args: { scheme: 'dark' } });
  await runCommand({ name: 'appearance', args: { scheme: 'system' } });
  expect(set.mock.calls).toEqual([['dark'], ['unspecified']]);
  expect((await failure(runCommand({ name: 'appearance', args: { scheme: 'blue' } }))).code).toBe('internal');
});
