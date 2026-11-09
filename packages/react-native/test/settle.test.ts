import { waitUntilSteady, waitUntilStill } from '../src/settle';

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

describe('waitUntilSteady', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function frames(values: Array<{ x: number; y: number } | null>) {
    let i = 0;
    return jest.fn(async (): Promise<{ x: number; y: number } | null> => values[Math.min(i++, values.length - 1)] ?? null);
  }

  test('stops once two readings in a row agree within 1 pt', async () => {
    const measure = frames([{ x: 0, y: 778 }, { x: 0, y: 650 }, { x: 0, y: 526 }, { x: 0, y: 526.5 }]);
    const done = waitUntilSteady(measure, { pollMs: 100, capMs: 2000, now: () => Date.now() });
    await jest.advanceTimersByTimeAsync(300);
    await expect(done).resolves.toBe(300);
    expect(measure).toHaveBeenCalledTimes(4);
  });

  test('ends at the cap when the reading never settles', async () => {
    let y = 0;
    const done = waitUntilSteady(async () => ({ x: 0, y: (y += 10) }), { pollMs: 100, capMs: 450, now: () => Date.now() });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toBe(450);
  });

  test('a null first reading skips the wait', async () => {
    const done = waitUntilSteady(async () => null, { pollMs: 100, capMs: 2000, now: () => Date.now() });
    await jest.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toBe(0);
  });
});
