import { clearSourceCache, framesOf, isAppFile, setSourceFetch, sourcesOf } from '../src/source';
import type { Fiber } from '../src/fiber';

// Source locations: from a fiber's `_debugStack` (Hermes frames into Metro's bundle) through Metro's
// /symbolicate to the line of the app's code that wrote the element.

const BUNDLE = 'http://192.168.1.20:8081/index.bundle//&platform=ios&dev=true';

function stack(...frames: Array<[string, number, number]>): { stack: string } {
  return { stack: ['Error: react-stack-top-frame', ...frames.map(([name, l, c]) => `    at ${name} (${BUNDLE}:${l}:${c})`)].join('\n') };
}

function fiber(tag: number, type: unknown, props: Record<string, unknown>, debugStack?: { stack: string }, parent: Fiber | null = null): Fiber {
  const f = { tag, type, elementType: type, memoizedProps: props, stateNode: null, child: null, sibling: null, return: parent } as Fiber & { _debugStack?: unknown };
  if (debugStack) f._debugStack = debugStack;
  return f;
}

/** Metro's map for the tests: bundle line -> original file, line, method. */
const MAP: Record<number, { file: string; lineNumber: number; column: number; methodName: string }> = {
  100: { file: '/proj/node_modules/react/cjs/react-jsx-dev-runtime.development.js', lineNumber: 50, column: 1, methodName: 'jsxDEV' },
  200: { file: '/proj/src/ui.tsx', lineNumber: 43, column: 7, methodName: 'Field' },
  300: { file: '/proj/node_modules/react-native/Libraries/Components/TextInput/TextInput.js', lineNumber: 900, column: 5, methodName: 'InternalTextInput' },
  400: { file: '/proj/src/screens/SignUpScreen.tsx', lineNumber: 112, column: 9, methodName: 'SignUpScreen' },
};

let requests = 0;
beforeEach(() => {
  clearSourceCache();
  requests = 0;
  setSourceFetch(async (url, init) => {
    requests++;
    expect(url).toBe('http://192.168.1.20:8081/symbolicate');
    const body = JSON.parse(init.body) as { stack: Array<{ lineNumber: number }> };
    return { ok: true, json: async () => ({ stack: body.stack.map((f) => MAP[f.lineNumber] ?? null) }) };
  });
});
afterEach(() => setSourceFetch(null));

test('reads Hermes frames from a fiber’s _debugStack', () => {
  const f = fiber(5, 'RCTView', {}, stack(['jsxDEV', 100, 3], ['Field', 200, 9]));
  expect(framesOf(f).map((x) => [x.methodName, x.lineNumber, x.column])).toEqual([
    ['jsxDEV', 100, 3],
    ['Field', 200, 9],
  ]);
  expect(framesOf(fiber(5, 'RCTView', {}))).toEqual([]);
});

test('app files are the ones outside node_modules', () => {
  expect(isAppFile('/proj/src/ui.tsx')).toBe(true);
  expect(isAppFile('C:\\proj\\node_modules\\react\\index.js')).toBe(false);
  expect(isAppFile(BUNDLE)).toBe(false);
});

test('an element the app wrote maps to its line, with the components above it and the props', async () => {
  function SignUpScreen(): null { return null; }
  function Field(): null { return null; }
  const screen = fiber(0, SignUpScreen, {}, stack(['jsxDEV', 100, 1], ['App', 400, 1]));
  const field = fiber(0, Field, { label: 'Name', testID: 'signup-name', onChangeText: function setName() {} }, stack(['jsxDEV', 100, 1], ['SignUpScreen', 400, 9]), screen);
  const view = fiber(5, 'RCTView', {}, stack(['jsxDEV', 100, 1], ['Field', 200, 7]), field);
  const [source] = await sourcesOf([view]);
  expect(source?.location).toEqual({ file: '/proj/src/ui.tsx', line: 43, column: 7, component: 'Field', direct: true });
  expect(source?.components).toEqual(['SignUpScreen', 'Field']);
  expect(requests).toBe(1);
});

test('an element a library drew (a TextInput’s native view) maps to the line the app wrote the TextInput', async () => {
  function Field(): null { return null; }
  function TextInput(): null { return null; }
  const field = fiber(0, Field, { label: 'Email' }, stack(['jsxDEV', 100, 1], ['SignUpScreen', 400, 9]));
  const input = fiber(11, TextInput, { placeholder: 'you@example.com', testID: 'signup-email' }, stack(['jsxDEV', 100, 1], ['Field', 200, 7]), field);
  const native = fiber(5, 'RCTSinglelineTextInputView', {}, stack(['jsxDEV', 100, 1], ['InternalTextInput', 300, 5]), input);
  const [source] = await sourcesOf([native]);
  expect(source?.location?.direct).toBe(true);
  expect(source?.location?.file).toBe('/proj/src/ui.tsx');
  expect(source?.location?.line).toBe(43);
  // the props are those of the component the app wrote there
  expect(source?.props).toEqual({ placeholder: '"you@example.com"', testID: '"signup-email"' });
  // the app's own components on the path: SignUpScreen wrote the Field, Field wrote the TextInput
  expect(source?.components).toEqual(['SignUpScreen', 'Field']);
});

test('several elements cost one request, and positions are cached', async () => {
  const a = fiber(5, 'RCTView', {}, stack(['Field', 200, 7]));
  const b = fiber(5, 'RCTView', {}, stack(['SignUpScreen', 400, 9]));
  await sourcesOf([a, b]);
  await sourcesOf([a, b]);
  expect(requests).toBe(1);
});

test('without Metro (no stack, or Metro unreachable) the location is null, never an error', async () => {
  expect((await sourcesOf([fiber(5, 'RCTView', {})]))[0]?.location).toBeNull();
  setSourceFetch(async () => {
    throw new Error('offline');
  });
  const [source] = await sourcesOf([fiber(5, 'RCTView', {}, stack(['Field', 200, 7]))]);
  expect(source?.location).toBeNull();
});

test('a wrapped element (a Pressable, several components deep) is the app line itself; a library-built one is the line around it', async () => {
  function Pressable(): null { return null; }
  function Inner(): null { return null; }
  function TabItem(): null { return null; }
  function Navigator(): null { return null; }
  // the app wrote <Pressable testID="save">; React Native wraps its view in an inner component
  const pressable = fiber(11, Pressable, { testID: 'save', onPress: () => undefined }, stack(['jsxDEV', 100, 1], ['SignUpScreen', 400, 9]));
  const inner = fiber(0, Inner, { testID: 'save' }, stack(['jsxDEV', 100, 1], ['InternalTextInput', 300, 5]), pressable);
  const view = fiber(5, 'RCTView', { testID: 'save' }, stack(['jsxDEV', 100, 1], ['InternalTextInput', 300, 5]), inner);
  expect((await sourcesOf([view]))[0]?.location?.direct).toBe(true);
  // the app wrote <Tab.Navigator>; the tab button's testID came from options, deep inside the library
  const nav = fiber(0, Navigator, { initialRouteName: 'Explore' }, stack(['jsxDEV', 100, 1], ['SignUpScreen', 400, 9]));
  const item = fiber(0, TabItem, { testID: 'tab-trips' }, stack(['jsxDEV', 100, 1], ['InternalTextInput', 300, 5]), nav);
  const wrap = fiber(0, Inner, {}, stack(['jsxDEV', 100, 1], ['InternalTextInput', 300, 5]), item);
  const button = fiber(5, 'RCTView', { testID: 'tab-trips' }, stack(['jsxDEV', 100, 1], ['InternalTextInput', 300, 5]), wrap);
  const [tab] = await sourcesOf([button]);
  expect(tab?.location?.direct).toBe(false);
  expect(tab?.location?.line).toBe(112);
});

test("an app's own wrapper (a shared <Button testID>) maps to the call site that wrote the id, not the wrapper's inside", async () => {
  function Button(): null { return null; }
  function Pressable(): null { return null; }
  // SignUpScreen.tsx:112 writes <Button testID="save" />; ui.tsx:43 (inside Button) writes <Pressable testID={testID}>
  const button = fiber(0, Button, { testID: 'save', label: 'Save' }, stack(['jsxDEV', 100, 1], ['SignUpScreen', 400, 9]));
  const pressable = fiber(11, Pressable, { testID: 'save' }, stack(['jsxDEV', 100, 1], ['Button', 200, 7]), button);
  const view = fiber(5, 'RCTView', { testID: 'save' }, stack(['jsxDEV', 100, 1], ['InternalTextInput', 300, 5]), pressable);
  const [source] = await sourcesOf([view]);
  expect(source?.location).toMatchObject({ file: '/proj/src/screens/SignUpScreen.tsx', line: 112, direct: true });
  expect(source?.props).toMatchObject({ testID: '"save"', label: '"Save"' });
});

test("inside a shared component that makes its own id (LabButton), it also names where the screen uses it", async () => {
  function LabButton(): null { return null; }
  function Pressable(): null { return null; }
  // SignUpScreen.tsx:112 writes <LabButton name="save" />; ui.tsx:43 (inside it) writes <Pressable testID={`lab-${name}`}>
  const button = fiber(0, LabButton, { name: 'save', title: 'Save' }, stack(['jsxDEV', 100, 1], ['SignUpScreen', 400, 9]));
  const pressable = fiber(11, Pressable, { testID: 'lab-save' }, stack(['jsxDEV', 100, 1], ['LabButton', 200, 7]), button);
  const view = fiber(5, 'RCTView', { testID: 'lab-save' }, stack(['jsxDEV', 100, 1], ['InternalTextInput', 300, 5]), pressable);
  const [source] = await sourcesOf([view]);
  expect(source?.location).toMatchObject({ file: '/proj/src/ui.tsx', line: 43, direct: true });
  expect(source?.usedAt).toMatchObject({ file: '/proj/src/screens/SignUpScreen.tsx', line: 112, component: 'SignUpScreen' });
});
