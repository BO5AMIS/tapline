import { PerfSampler, perfStart, perfStop, stopPerf, DROP_MS, type PerfDeps } from '../src/perf';
import { methods } from '../src/methods';
import { defaultCapabilities } from '../src/client';
import { HostRoot } from '../src/fiber';

/** A clock and a requestAnimationFrame that only move when the test says so. */
function fakeTime(heap: (() => number | null) | undefined = undefined) {
  let now = 0;
  let pending: (() => void) | null = null;
  let heapTimer: (() => void) | null = null;
  const commitListeners = new Set<(root: unknown) => void>();
  const stateListeners = new Set<(state: string) => void>();
  const deps: Partial<PerfDeps> = {
    onAppState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    now: () => now,
    requestFrame: (fn) => {
      pending = fn;
      return 1;
    },
    cancelFrame: () => {
      pending = null;
    },
    setInterval: (fn) => {
      heapTimer = fn;
      return 2;
    },
    clearInterval: () => {
      heapTimer = null;
    },
    heapMb: heap ?? (() => null),
    onCommitRoot: (listener) => {
      commitListeners.add(listener);
      return () => commitListeners.delete(listener);
    },
  };
  return {
    deps,
    /** Time passes; a frame is delivered at the end of it. */
    frame(ms: number) {
      now += ms;
      const fn = pending;
      pending = null;
      fn?.();
    },
    /** Time passes with no frame. */
    idle(ms: number) {
      now += ms;
    },
    tickHeap() {
      heapTimer?.();
    },
    appState(state: string) {
      for (const l of [...stateListeners]) l(state);
    },
    stateListeners: () => stateListeners.size,
    commit(root: unknown) {
      for (const l of [...commitListeners]) l(root);
    },
    hasHeapTimer: () => heapTimer !== null,
    hasFrame: () => pending !== null,
    listeners: () => commitListeners.size,
  };
}

describe('PerfSampler maths', () => {
  test('60 fps for 2 s: average 60, lowest 60, no drops, busy about 16 ms', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    // 125 frames of 16 ms is 2000 ms
    for (let i = 0; i < 125; i++) t.frame(16);
    const r = s.stop();
    expect(r.seconds).toBe(2);
    expect(r.frames).toBe(125);
    expect(r.fps).toBeCloseTo(62.5, 1);
    expect(r.fpsLowest).toBeGreaterThanOrEqual(61);
    expect(r.drops).toBe(0);
    expect(r.busyMs).toBe(16);
    expect(r.heapMb).toBeUndefined();
    expect(r.renders).toBeUndefined();
  });

  test('a drop is an interval over 50 ms; 50 ms exactly is not one', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    t.frame(16);
    t.frame(DROP_MS);
    t.frame(51);
    t.frame(180);
    t.frame(16);
    const r = s.stop();
    expect(r.drops).toBe(2);
    expect(r.busyMs).toBe(180);
  });

  test('a stretch in the background is no frame interval: not a drop, not the longest stall', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    t.frame(16);
    t.appState('background');
    t.idle(8000); // requestAnimationFrame is paused
    t.appState('active');
    t.frame(16);
    t.frame(16);
    const r = s.stop();
    expect(r.drops).toBe(0);
    expect(r.busyMs).toBeLessThanOrEqual(16);
    expect(t.stateListeners()).toBe(0);
  });

  test('a frame that comes before the app-state change still skips the interval, and a window ending in the background has no tail stall', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    t.frame(16);
    t.appState('inactive');
    t.frame(900);
    t.appState('background');
    t.idle(5000);
    const r = s.stop();
    expect(r.drops).toBe(0);
    expect(r.busyMs).toBeLessThanOrEqual(16);
  });

  test('a second in the background lowers neither fps nor the lowest second (CodeRabbit, PR #4)', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    for (let i = 0; i < 60; i++) t.frame(1000 / 60);
    t.appState('background');
    t.idle(1000);
    t.appState('active');
    for (let i = 0; i < 60; i++) t.frame(1000 / 60);
    const r = s.stop();
    expect(r.fps).toBeGreaterThanOrEqual(59);
    expect(r.fpsLowest).toBeGreaterThanOrEqual(59);
    expect(r.seconds).toBeLessThan(2.1);
  });

  test('a callback while the app is inactive is not counted as a frame (Codex re-review 3, PR #4)', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    t.frame(16);
    t.appState('inactive');
    t.frame(500); // delivered while away
    t.appState('active');
    t.frame(16);
    const r = s.stop();
    expect(r.frames).toBe(2);
    expect(r.fps).toBeCloseTo(62.5, 0);
  });

  test('a late first frame after coming back is a stall (CodeRabbit, PR #4)', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    t.frame(16);
    t.appState('background');
    t.idle(2000);
    t.appState('active');
    t.frame(500);
    const r = s.stop();
    expect(r.drops).toBe(1);
    expect(r.busyMs).toBe(500);
  });

  test('a real stall after coming back is still a drop', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    t.appState('background');
    t.idle(3000);
    t.appState('active');
    t.frame(16);
    t.frame(120);
    expect(s.stop().drops).toBe(1);
  });

  test('the lowest sample is the slowest whole second; the last partial second is left out', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    // second 0: 49 frames of 20 ms (to 980 ms); the frame at 1000 ms and 19 of 50 ms make 20 in second 1;
    // the frames at 2000 and 2010 ms are a partial third second
    for (let i = 0; i < 49; i++) t.frame(20);
    t.frame(20);
    for (let i = 0; i < 19; i++) t.frame(50);
    t.frame(50);
    t.frame(10);
    const r = s.stop();
    expect(r.seconds).toBe(2);
    expect(r.fpsLowest).toBe(20);
    expect(r.fps).toBeCloseTo(71 / 2.01, 1);
    expect(r.drops).toBe(0);
    expect(r.busyMs).toBe(50);
  });

  test('a window under a second reports its average as the lowest', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    for (let i = 0; i < 20; i++) t.frame(25);
    const r = s.stop();
    expect(r.seconds).toBe(0.5);
    expect(r.fps).toBe(40);
    expect(r.fpsLowest).toBe(40);
  });

  test('a second with no frame at all counts as 0 fps', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    t.frame(16);
    t.frame(2100); // JS frozen for two seconds
    t.frame(16);
    const r = s.stop();
    expect(r.fpsLowest).toBe(0);
    expect(r.drops).toBe(1);
    expect(r.busyMs).toBe(2100);
  });

  test('a stall still going when the window ends counts as a drop and as busy time', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    t.frame(16);
    t.idle(300);
    const r = s.stop();
    expect(r.drops).toBe(1);
    expect(r.busyMs).toBe(300);
  });

  test('the heap is sampled at the start, about every 250 ms and at the end; peak is the largest', () => {
    const readings = [40, 52, 44, 48];
    let i = 0;
    const t = fakeTime(() => readings[i++] ?? 48);
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start(); // 40
    t.frame(16);
    t.tickHeap(); // 52
    t.tickHeap(); // 44
    t.frame(16);
    const r = s.stop(); // 48
    expect(r.heapMb).toBe(48);
    expect(r.heapPeakMb).toBe(52);
  });

  test('stopping releases the loop, the heap timer and the commit listener; stop twice is bad_params', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: true });
    s.start();
    expect(t.hasFrame()).toBe(true);
    expect(t.hasHeapTimer()).toBe(true);
    expect(t.listeners()).toBe(1);
    s.stop();
    expect(t.hasFrame()).toBe(false);
    expect(t.hasHeapTimer()).toBe(false);
    expect(t.listeners()).toBe(0);
    expect(() => s.stop()).toThrow(/no performance measurement/);
  });

  test('abort ends the window without a result', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: true });
    s.start();
    s.abort();
    expect(s.active).toBe(false);
    expect(t.hasFrame()).toBe(false);
    expect(t.listeners()).toBe(0);
  });
});

interface TestFiber {
  tag: number;
  type: unknown;
  elementType: unknown;
  memoizedProps: unknown;
  stateNode: unknown;
  child: TestFiber | null;
  sibling: TestFiber | null;
  return: TestFiber | null;
  flags: number;
  subtreeFlags?: number;
  actualDuration?: number;
}

function component(name: string, actualDuration: number | undefined, flags = 1, children: TestFiber[] = []): TestFiber {
  const type = { displayName: name };
  const fiber: TestFiber = {
    tag: 0,
    type,
    elementType: type,
    memoizedProps: {},
    stateNode: null,
    child: null,
    sibling: null,
    return: null,
    flags,
    ...(actualDuration !== undefined ? { actualDuration } : {}),
  };
  children.forEach((c, i) => {
    c.return = fiber;
    c.sibling = children[i + 1] ?? null;
  });
  fiber.child = children[0] ?? null;
  return fiber;
}

function rootOf(child: TestFiber): { current: TestFiber } {
  const current: TestFiber = {
    tag: HostRoot,
    type: null,
    elementType: null,
    memoizedProps: null,
    stateNode: null,
    child,
    sibling: null,
    return: null,
    flags: 0,
  };
  child.return = current;
  return { current };
}

describe('PerfSampler render times (development builds)', () => {
  test("reports each component's own longest render, its count, longest first", () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: true });
    s.start();
    // App 60.4 ms in all: TripList 48 (DayCard 13 inside it, so TripList's own time is 35), a Header 0.4 ms
    const dayCard = component('DayCard', 13);
    const tripList = component('TripList', 48, 1, [dayCard]);
    const header = component('Header', 0.4);
    const app = component('App', 60.4, 1, [tripList, header]);
    t.commit(rootOf(app));
    const tripList2 = component('TripList', 30);
    t.commit(rootOf(component('App', 31, 1, [tripList2])));
    t.commit(rootOf(component('TripList', 10)));
    t.frame(100);
    const r = s.stop();
    // App's own time is 60.4 - 48 - 0.4 = 12 once and 1 once; Header's 0.4 ms is too quick to list
    expect(r.renders).toEqual([
      { name: 'TripList', ms: 35, count: 3 },
      { name: 'DayCard', ms: 13, count: 1 },
      { name: 'App', ms: 12, count: 2 },
    ]);
  });

  test('a component that did not render in this commit is ignored even with a stale duration', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: true });
    s.start();
    t.commit(rootOf(component('Stale', 90, 0)));
    t.frame(16);
    expect(s.stop().renders).toEqual([]);
  });

  test('a subtree React says did no work is not walked', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: true });
    s.start();
    const inner = component('Inner', 40);
    const outer = component('Outer', 5, 0, [inner]);
    outer.subtreeFlags = 0;
    t.commit(rootOf(outer));
    t.frame(16);
    expect(s.stop().renders).toEqual([]);
  });

  test('renders React gave no timing for leave renders out', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: true });
    s.start();
    t.commit(rootOf(component('NoTiming', undefined)));
    t.frame(16);
    expect(s.stop().renders).toBeUndefined();
  });

  test('outside a development build nothing listens for commits and there are no renders', () => {
    const t = fakeTime();
    const s = new PerfSampler({ ...t.deps, dev: false });
    s.start();
    expect(t.listeners()).toBe(0);
    t.frame(16);
    expect(s.stop().renders).toBeUndefined();
  });
});

describe('the perf methods', () => {
  afterEach(() => stopPerf());

  test('are listed and the app advertises the performance capability', () => {
    expect(typeof methods.perfStart).toBe('function');
    expect(typeof methods.perfStop).toBe('function');
    expect(typeof methods.perfSettle).toBe('function');
    expect(defaultCapabilities()).toContain('performance');
  });

  test('perfStop without perfStart is bad_params', async () => {
    await expect(perfStop()).rejects.toMatchObject({ code: 'bad_params' });
  });

  test('perfStart then perfStop answers the numbers; a second perfStop is bad_params', async () => {
    const started = await perfStart();
    expect(started.started).toBe(true);
    const result = await perfStop();
    expect(result.frames).toBeGreaterThanOrEqual(0);
    expect(typeof result.fps).toBe('number');
    await expect(perfStop()).rejects.toMatchObject({ code: 'bad_params' });
  });

  test('stopPerf (the host went away) ends the loop', async () => {
    await perfStart();
    stopPerf();
    await expect(perfStop()).rejects.toMatchObject({ code: 'bad_params' });
  });

  test('a second start while one runs is refused, and the first window keeps its numbers (Codex review of 1.3.0)', async () => {
    const first = await perfStart();
    await expect(perfStart()).rejects.toMatchObject({ code: 'bad_params', message: expect.stringContaining('already running') });
    // a stop that names another window doesn't end this one
    await expect(perfStop({ id: first.id + 1 })).rejects.toMatchObject({ code: 'bad_params' });
    const result = await perfStop({ id: first.id });
    expect(typeof result.fps).toBe('number');
    // and a new window can start after it ended
    const next = await perfStart();
    expect(next.id).toBeGreaterThan(first.id);
  });
});
