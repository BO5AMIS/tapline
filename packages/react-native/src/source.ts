import { isCompositeTag, propsOf, type Fiber } from './fiber';
import { isRecord } from './types';

/** The most of a string prop sent to the host, which redacts first and cuts for display (AGENT-TOOLS §20.3). */
const MAX_PROP_CHARS = 2000;

/** The first `max` UTF-16 units, one fewer when that would cut an emoji in half. */
function wholeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Source locations (Tapline 1.1, development builds): which component draws an element and which line of
 * the app's code wrote it. React 19 keeps, on every fiber, the stack captured where its JSX element was
 * created (`_debugStack`). The frames point into the bundle Metro serves; Metro's own `/symbolicate`
 * turns them back into the app's files and lines. The first frame outside node_modules is the line that
 * wrote the element. Nothing here runs unless the agent asks.
 */

export interface SourceLocation {
  /** The file as Metro reports it (absolute on the computer that serves the bundle). */
  file: string;
  line: number;
  column: number;
  /** The component whose render wrote the element, e.g. "SignUpScreen". */
  component: string | null;
  /** True when this is the element's own line; false when a library drew it and this is the app line around it. */
  direct: boolean;
}

export interface ElementSource {
  /** Components from the screen down to the element, app components first (at most 6). */
  components: string[];
  /** Where the app's code wrote this element (or its nearest ancestor the app wrote); null when unknown. */
  location: SourceLocation | null;
  /**
   * When `location` is inside one of the app's own components (a shared button): where the screen uses that
   * component, so a developer goes straight to the use as well as to the inside. Absent otherwise.
   */
  usedAt?: SourceLocation[];
  /** The props of the component the app wrote, in short: strings, numbers, booleans, handler names. */
  props: Record<string, string>;
}

interface Frame {
  file: string;
  lineNumber: number;
  column: number;
  methodName: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

let fetcher: FetchLike | null = null;

/** Replace the HTTP client (tests); null restores the global fetch. */
export function setSourceFetch(next: FetchLike | null): void {
  fetcher = next;
}

function http(): FetchLike | null {
  if (fetcher) return fetcher;
  const global = (globalThis as { fetch?: unknown }).fetch;
  return typeof global === 'function' ? (global as FetchLike) : null;
}

/** The stack React captured where this fiber's element was created, as frames; empty when there is none. */
export function framesOf(fiber: Fiber): Frame[] {
  const stack = (fiber as Fiber & { _debugStack?: unknown })._debugStack;
  const text = isRecord(stack) && typeof stack.stack === 'string' ? stack.stack : typeof stack === 'string' ? stack : '';
  const frames: Frame[] = [];
  for (const line of text.split('\n')) {
    // Hermes and V8: "at name (url:line:col)" or "at url:line:col"
    const m = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const file = m[2]!.replace(/^address at\s+/, '');
    frames.push({ methodName: m[1] ?? '', file, lineNumber: Number(m[3]), column: Number(m[4]) });
  }
  return frames;
}

/** Metro's address, from a bundle URL in a frame: "http://192.168.1.20:8081". */
function metroOrigin(frames: Frame[]): string | null {
  for (const frame of frames) {
    const m = /^(https?:\/\/[^/]+)\//.exec(frame.file);
    if (m) return m[1]!;
  }
  return null;
}

const cache = new Map<string, Frame | null>();
const keyOf = (f: Frame): string => `${f.file}:${f.lineNumber}:${f.column}`;

/** Asks Metro for the original positions of these frames; frames it can't map come back null. */
async function symbolicate(frames: Frame[]): Promise<Array<Frame | null>> {
  const missing = frames.filter((f) => !cache.has(keyOf(f)));
  const origin = metroOrigin(missing);
  const client = http();
  if (missing.length > 0 && origin && client) {
    try {
      const res = await client(`${origin}/symbolicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stack: missing }),
      });
      const body: unknown = res.ok ? await res.json() : null;
      const out = isRecord(body) && Array.isArray(body.stack) ? body.stack : [];
      missing.forEach((frame, i) => {
        const mapped: unknown = out[i];
        cache.set(
          keyOf(frame),
          isRecord(mapped) && typeof mapped.file === 'string' && typeof mapped.lineNumber === 'number'
            ? {
                file: mapped.file,
                lineNumber: mapped.lineNumber,
                column: typeof mapped.column === 'number' ? mapped.column : 0,
                methodName: typeof mapped.methodName === 'string' ? mapped.methodName : '',
              }
            : null,
        );
      });
    } catch {
      // Metro unreachable: no locations this time; try again next call.
      return frames.map(() => null);
    }
  }
  return frames.map((f) => cache.get(keyOf(f)) ?? null);
}

/**
 * A stack (as Hermes or V8 print it) with each frame Metro can map rewritten to the app's file and line.
 * Frames Metro can't map, and lines that aren't frames, stay as they were. Development builds only.
 */
export async function symbolicateStack(stack: string): Promise<string> {
  const lines = stack.split('\n');
  const frames: Frame[] = [];
  const at: number[] = [];
  lines.forEach((line, i) => {
    const m = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) return;
    frames.push({ methodName: m[1] ?? '', file: m[2]!.replace(/^address at\s+/, ''), lineNumber: Number(m[3]), column: Number(m[4]) });
    at.push(i);
  });
  if (frames.length === 0) return stack;
  const mapped = await symbolicate(frames);
  mapped.forEach((frame, k) => {
    if (frame === null) return;
    const name = frame.methodName !== '' ? frame.methodName : frames[k]!.methodName;
    lines[at[k]!] = `    at ${name !== '' ? `${name} (` : ''}${frame.file}:${frame.lineNumber}:${frame.column}${name !== '' ? ')' : ''}`;
  });
  return lines.join('\n');
}

/** A file of the app's own code (not a library, not React's internals). */
export function isAppFile(file: string): boolean {
  return !/[\\/]node_modules[\\/]/.test(file) && !/^https?:/.test(file) && !/^\[native code\]$/.test(file);
}

const INTERNAL = /^(View|Text|RCT|Animated|Virtualized|ScrollView|Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|TextInput|Image|Context|Provider|Consumer|Fragment)/;

/** The composite components above a fiber, nearest first. */
function compositesAbove(fiber: Fiber, limit: number): Fiber[] {
  const out: Fiber[] = [];
  for (let f: Fiber | null = fiber; f && out.length < limit; f = f.return) {
    if (isCompositeTag(f.tag)) out.push(f);
  }
  return out;
}

function shortProps(fiber: Fiber): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(propsOf(fiber))) {
    if (key === 'children' || key === 'style' || Object.keys(out).length >= 8) continue;
    // Uncut (up to the usual cap): the host redacts vault values first and cuts for display afterwards (AGENT-TOOLS §20.3).
    if (typeof value === 'string') out[key] = JSON.stringify(wholeSlice(value, MAX_PROP_CHARS));
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
    else if (typeof value === 'function') out[key] = `${(value as { name?: string }).name || 'function'}()`;
  }
  return out;
}

/**
 * Whether the component the app wrote is the element itself, wrapped: it was given the element's own
 * testID, accessibility label or text (a Pressable, a TextInput, a Text). A tab bar button gets its testID
 * from the navigator's options instead, so the navigator's line is only the line around it.
 */
function sameIdentity(host: Fiber, wrote: Fiber): boolean {
  const own = propsOf(host);
  const given = propsOf(wrote);
  for (const key of ['testID', 'nativeID', 'accessibilityLabel', 'aria-label']) {
    const value = own[key];
    if (typeof value === 'string' && value !== '' && given[key] === value) return true;
  }
  return typeof own.children === 'string' && own.children !== '' && given.children === own.children;
}

/**
 * Where the app wrote these elements. One request to Metro for all of them. `fibers` are the host fibers
 * of the elements; for one written inside a library component (a TextInput's native view), the nearest
 * ancestor the app's code wrote is used.
 */
export async function sourcesOf(fibers: Fiber[]): Promise<ElementSource[]> {
  // For each element: the fibers to try, nearest first (the host fiber, then the composites above it, up to
  // the screen). An element a library drew (a tab bar button) maps to the app line that set the library up.
  const chains = fibers.map((fiber) => [fiber, ...compositesAbove(fiber.return ?? fiber, 60)]);
  const allFrames: Frame[] = [];
  const spans = chains.map((chain) =>
    chain.map((f) => {
      const frames = framesOf(f).slice(0, 4);
      const start = allFrames.length;
      allFrames.push(...frames);
      return { fiber: f, start, count: frames.length };
    }),
  );
  const mapped = await symbolicate(allFrames);
  /** The first frame of the app's own code in a fiber's stack: the app line that created that fiber's element. */
  const appFrame = (span: { start: number; count: number }): Frame | null => {
    for (let k = span.start; k < span.start + span.count; k++) {
      const frame = mapped[k];
      if (frame && isAppFile(frame.file)) return frame;
    }
    return null;
  };
  return fibers.map((fiber, i) => {
    let location: SourceLocation | null = null;
    let wrote: Fiber | null = null;
    // The app's own components, nearest first: the ones whose render wrote an element on this path.
    const names: string[] = [];
    for (const [n, span] of spans[i]!.entries()) {
      const frame = appFrame(span);
      if (frame === null) continue;
      if (frame.methodName !== '' && !INTERNAL.test(frame.methodName)) names.push(frame.methodName);
      if (location === null) {
        location = {
          file: frame.file,
          line: frame.lineNumber,
          column: frame.column,
          component: frame.methodName || null,
          // the element's own line, or (a library drew it) the app line around it
          direct: n <= 1 || sameIdentity(fiber, span.fiber),
        };
        wrote = span.fiber;
      } else if (location.direct && wrote !== null && sameIdentity(fiber, span.fiber)) {
        // The app's own wrapper component got the same identity from further up (a shared <Button testID>
        // used on a screen): the line that wrote the value is that call site, not the wrapper's inside.
        location = { file: frame.file, line: frame.lineNumber, column: frame.column, component: frame.methodName || null, direct: true };
        wrote = span.fiber;
      }
    }
    const components = [...new Set(names)].slice(0, 6).reverse();
    const propsFrom = wrote && isCompositeTag(wrote.tag) ? wrote : compositesAbove(fiber, 1)[0] ?? null;
    // Inside an app component (LabButton): the first app line further up written by another component is
    // where that component is used (<LabButton …> in LabScreen).
    // Up to four call sites further up, nearest first: a shared component may sit inside another one
    // (PressButton › LabButton), and the host picks the line that names the element.
    const usedAt: SourceLocation[] = [];
    const chosen: SourceLocation | null = location;
    if (chosen !== null && chosen.direct && chosen.component !== null) {
      let past = false;
      let last = chosen.component;
      for (const span of spans[i]!) {
        if (span.fiber === wrote) {
          past = true;
          continue;
        }
        if (!past) continue;
        const frame = appFrame(span);
        if (frame === null || frame.methodName === '' || INTERNAL.test(frame.methodName)) continue;
        if (frame.methodName === last) continue;
        usedAt.push({ file: frame.file, line: frame.lineNumber, column: frame.column, component: frame.methodName, direct: true });
        last = frame.methodName;
        if (usedAt.length >= 4) break;
      }
    }
    return { components, location, ...(usedAt.length > 0 ? { usedAt } : {}), props: propsFrom ? shortProps(propsFrom) : {} };
  });
}

/** Forget mapped positions (after a reload the bundle's lines change; tests). */
export function clearSourceCache(): void {
  cache.clear();
}
