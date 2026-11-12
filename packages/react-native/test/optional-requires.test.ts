import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// An app that lacks an optional module must still bundle: Metro treats `require('x')` as optional only when the call
// sits directly inside a `try` block (found on the phone, 2026-11-12: Wayfare without expo-media-library failed to
// bundle with SDK 1.5). Every require of a package the SDK doesn't depend on must be the first statement of a try.

const ALWAYS_THERE = new Set(['react', 'react-native']);

test('every require of an optional package is directly inside a try block', () => {
  const dir = join(__dirname, '..', 'src');
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
    const lines = readFileSync(join(dir, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const match = /\brequire\(\s*'([^']+)'\s*\)/.exec(line);
      if (!match) return;
      const name = match[1] ?? '';
      if (name.startsWith('.') || ALWAYS_THERE.has(name)) return;
      // the nearest code line above must open a try block
      let above = i - 1;
      while (above >= 0 && /^\s*(\/\/.*)?$/.test(lines[above] ?? '')) above--;
      if (!/\btry\s*\{\s*$/.test(lines[above] ?? '')) offenders.push(`${file}:${i + 1} require('${name}')`);
    });
  }
  expect(offenders).toEqual([]);
});
