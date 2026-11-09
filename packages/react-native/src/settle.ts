/**
 * AGENT-TOOLS §6: the screen counts as still after `quietMs` without a React commit, with a cap.
 * Resolves with the milliseconds waited. Native-driver animations don't commit, so the tree can be
 * still while pixels move; that's fine for an element list.
 */
export function waitUntilStill(options: {
  quietMs: number;
  capMs: number;
  onCommit: (listener: () => void) => () => void;
  now: () => number;
}): Promise<number> {
  const started = options.now();
  return new Promise((resolve) => {
    let done = false;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (quiet !== undefined) clearTimeout(quiet);
      clearTimeout(cap);
      unsubscribe();
      resolve(Math.max(0, Math.min(options.capMs, options.now() - started)));
    };
    const cap = setTimeout(finish, options.capMs);
    const restart = (): void => {
      if (done) return;
      if (quiet !== undefined) clearTimeout(quiet);
      quiet = setTimeout(finish, options.quietMs);
    };
    unsubscribe = options.onCommit(restart);
    restart();
  });
}
