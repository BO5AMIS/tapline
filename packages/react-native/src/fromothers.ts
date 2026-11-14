import { createElement, Fragment, type ReactNode } from 'react';
import { propsOf, type Fiber } from './fiber';

/**
 * AGENT-TOOLS 1.14 §21.1: text that other people wrote (comments, emails, messages) is marked by the app. Everything inside a
 * marked subtree reaches the agent as `(from others)`. Unmarked text is never claimed either way.
 */
const MARK = '__taplineFromOthers';

/**
 * Wraps views whose text others wrote. It draws nothing of its own: its children render as they would without it.
 * `<Text taplineFromOthers>…</Text>` marks one Text the same way.
 */
export function TaplineFromOthers({ children }: { children?: ReactNode }): ReturnType<typeof createElement> {
  return createElement(Fragment, null, children);
}
Object.defineProperty(TaplineFromOthers, MARK, { value: true });

/** Whether this fiber starts a marked subtree: the wrapper, or any component or host view with `taplineFromOthers`. */
export function marksFromOthers(fiber: Fiber): boolean {
  if (propsOf(fiber).taplineFromOthers === true) return true;
  const type = fiber.type;
  return typeof type === 'function' && Reflect.get(type, MARK) === true;
}
