import { isRecord, type UnknownRecord } from './types';

/**
 * Minimal structural view of a React fiber. Only the fields Tapline reads are
 * declared; everything else about fibers is private to React.
 */
export interface Fiber {
  tag: number;
  type: unknown;
  elementType: unknown;
  memoizedProps: unknown;
  stateNode: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate?: Fiber | null;
}

/** Minimal view of a FiberRoot as handed to `onCommitFiberRoot`. */
export interface FiberRootLike {
  current: Fiber;
}

// Fiber tags (stable across React 17-19).
export const FunctionComponent = 0;
export const ClassComponent = 1;
export const IndeterminateComponent = 2;
export const HostRoot = 3;
export const HostComponent = 5;
export const HostText = 6;
export const ForwardRef = 11;
export const MemoComponent = 14;
export const SimpleMemoComponent = 15;

export function isFiber(value: unknown): value is Fiber {
  return (
    isRecord(value) &&
    typeof value.tag === 'number' &&
    'memoizedProps' in value &&
    'child' in value &&
    'sibling' in value
  );
}

export function isFiberRoot(value: unknown): value is FiberRootLike {
  return isRecord(value) && isFiber(value.current);
}

export function isCompositeTag(tag: number): boolean {
  return (
    tag === FunctionComponent ||
    tag === ClassComponent ||
    tag === IndeterminateComponent ||
    tag === ForwardRef ||
    tag === MemoComponent ||
    tag === SimpleMemoComponent
  );
}

/** Props of a fiber as a plain record ({} when absent or a text string). */
export function propsOf(fiber: Fiber): UnknownRecord {
  return isRecord(fiber.memoizedProps) ? fiber.memoizedProps : {};
}

/** The first host fiber below `fiber` in tree order (a scroll view's content container); null when none. */
export function firstHostChild(fiber: Fiber): Fiber | null {
  for (let child = fiber.child; child; child = child.sibling) {
    if (child.tag === HostComponent) return child;
    const nested = firstHostChild(child);
    if (nested) return nested;
  }
  return null;
}

/** The host fibers directly below `fiber`, looking through non-host wrappers but not into hosts. */
export function hostChildren(fiber: Fiber): Fiber[] {
  const found: Fiber[] = [];
  const visit = (first: Fiber | null): void => {
    for (let child = first; child; child = child.sibling) {
      if (child.tag === HostComponent) found.push(child);
      else visit(child.child);
    }
  };
  visit(fiber.child);
  return found;
}

/** Best-effort display name of a component type; null when anonymous. */
export function componentName(type: unknown, depth = 0): string | null {
  if (depth > 4 || type == null) return null;
  if (typeof type === 'string') return type;
  if (typeof type === 'function') {
    const named = type as { displayName?: unknown; name?: unknown };
    if (typeof named.displayName === 'string' && named.displayName) return named.displayName;
    if (typeof named.name === 'string' && named.name) return named.name;
    return null;
  }
  if (isRecord(type)) {
    if (typeof type.displayName === 'string' && type.displayName) return type.displayName;
    // forwardRef({render}) / memo({type}) wrappers
    return componentName(type.render, depth + 1) ?? componentName(type.type, depth + 1);
  }
  return null;
}

export function fiberName(fiber: Fiber): string | null {
  return componentName(fiber.type) ?? componentName(fiber.elementType);
}

/** Whether `fiber` is `other` or its alternate (the same logical fiber). */
export function sameFiber(fiber: Fiber, other: Fiber): boolean {
  return fiber === other || fiber === other.alternate || fiber.alternate === other;
}
