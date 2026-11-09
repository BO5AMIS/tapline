import { waitUntilStill } from '../src/settle';

function fakeCommits() {
  const listeners = new Set<() => void>();
  return {
    onCommit: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    commit: () => { for (const fn of [...listeners]) fn(); },
  };
}

describe('waitUntilStill', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('answers 100 ms after the last commit', async () => {
    const c = fakeCommits();
    const done = waitUntilStill({ quietMs: 100, capMs: 2000, onCommit: c.onCommit, now: () => Date.now() });
    await jest.advanceTimersByTimeAsync(60);
    c.commit();
    await jest.advanceTimersByTimeAsync(60);
    c.commit();
    await jest.advanceTimersByTimeAsync(100);
    await expect(done).resolves.toBe(220);
  });

  test('stops at the cap when the app never goes still', async () => {
    const c = fakeCommits();
    const done = waitUntilStill({ quietMs: 100, capMs: 2000, onCommit: c.onCommit, now: () => Date.now() });
    for (let t = 0; t < 2100; t += 50) { c.commit(); await jest.advanceTimersByTimeAsync(50); }
    await expect(done).resolves.toBe(2000);
  });

  test('a still app answers after the quiet time', async () => {
    const c = fakeCommits();
    const done = waitUntilStill({ quietMs: 100, capMs: 2000, onCommit: c.onCommit, now: () => Date.now() });
    await jest.advanceTimersByTimeAsync(100);
    await expect(done).resolves.toBe(100);
  });

  test('with no quiet time and no cap it answers at once', async () => {
    const c = fakeCommits();
    const done = waitUntilStill({ quietMs: 0, capMs: 0, onCommit: c.onCommit, now: () => Date.now() });
    await jest.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toBe(0);
  });

  test('stops listening to commits once it has answered', async () => {
    const c = fakeCommits();
    const done = waitUntilStill({ quietMs: 100, capMs: 2000, onCommit: c.onCommit, now: () => Date.now() });
    await jest.advanceTimersByTimeAsync(100);
    await done;
    expect(() => c.commit()).not.toThrow();
    await jest.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toBe(100);
  });
});
