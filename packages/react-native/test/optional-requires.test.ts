import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// An app that lacks an optional module must still bundle: Metro treats `require('x')` as optional only when the call
// sits directly inside a `try` block (found on the phone, 2026-11-12: Wayfare without expo-media-library failed to
// bundle with SDK 1.5). Every require of a package the SDK doesn't depend on must be the first statement of a try.

const ALWAYS_THERE = new Set(['react', 'react-native']);

/** The requires of optional packages in `source` that are not the first statement of a try block, single or double quoted. */
function offendersIn(file: string, source: string): string[] {
  const offenders: string[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, i) => {
    const match = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/.exec(line);
    if (!match) return;
    const name = match[2] ?? '';
    if (name.startsWith('.') || ALWAYS_THERE.has(name)) return;
    // the nearest code line above must open a try block
    let above = i - 1;
    while (above >= 0 && /^\s*(\/\/.*)?$/.test(lines[above] ?? '')) above--;
    if (!/\btry\s*\{\s*$/.test(lines[above] ?? '')) offenders.push(`${file}:${i + 1} require('${name}')`);
  });
  return offenders;
}

test('every require of an optional package is directly inside a try block', () => {
  const dir = join(__dirname, '..', 'src');
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
    offenders.push(...offendersIn(file, readFileSync(join(dir, file), 'utf8')));
  }
  expect(offenders).toEqual([]);
});

test('the guard catches a double-quoted require outside a try block, and accepts one inside', () => {
  expect(offendersIn('x.ts', 'const m = require("expo-media-library");')).toEqual(["x.ts:1 require('expo-media-library')"]);
  expect(offendersIn('x.ts', "const m = require('expo-media-library');")).toHaveLength(1);
  expect(offendersIn('x.ts', 'try {\n  return require("expo-media-library");\n} catch {\n  return null;\n}')).toEqual([]);
});
