import { isTaplineLink, parseTaplineLink } from '../src/link';

const PAIR = 'myapp://tapline/pair?url=ws%3A%2F%2F100.64.0.1%3A7211%2F&code=abc-123&name=Dev%20PC';

describe('parseTaplineLink', () => {
  test('reads a pairing link', () => {
    expect(parseTaplineLink(PAIR)).toEqual({ kind: 'pair', url: 'ws://100.64.0.1:7211/', code: 'abc-123', name: 'Dev PC' });
  });

  test('reads the forget link', () => {
    expect(parseTaplineLink('myapp://tapline/forget')).toEqual({ kind: 'forget' });
    expect(parseTaplineLink('myapp://tapline/forget/')).toEqual({ kind: 'forget' });
  });

  test('a pairing link without a name still works', () => {
    const link = parseTaplineLink('myapp://tapline/pair?url=wss%3A%2F%2Fhost.example&code=c1');
    expect(link).toEqual({ kind: 'pair', url: 'wss://host.example', code: 'c1', name: 'a computer' });
  });

  test('rejects links that are not complete Tapline links', () => {
    for (const url of [
      'myapp://settings',
      'myapp://tapline/other',
      'https://tapline/pair?url=ws%3A%2F%2Fh%3A1&code=c',
      'myapp://tapline/pair?code=c',
      'myapp://tapline/pair?url=ws%3A%2F%2Fh%3A1',
      'myapp://tapline/pair?url=http%3A%2F%2Fh%3A1&code=c',
      'myapp://tapline/pair?url=%E0%A4%A&code=c',
      '',
    ]) {
      expect(parseTaplineLink(url)).toBeNull();
    }
  });

  test('rejects an address with user info, which could hide the real host', () => {
    expect(parseTaplineLink('myapp://tapline/pair?url=ws%3A%2F%2F100.64.0.1%3A7210%40evil.example%2F&code=c')).toBeNull();
  });

  test('cleans control characters out of the computer name', () => {
    const link = parseTaplineLink('myapp://tapline/pair?url=ws%3A%2F%2Fh%3A1&code=c&name=Dev%0A%0APC%07');
    expect(link).toMatchObject({ name: 'Dev PC' });
  });

  test('the first value wins and odd keys are harmless', () => {
    const link = parseTaplineLink(`${PAIR}&code=other&__proto__=x&constructor=y`);
    expect(link).toMatchObject({ kind: 'pair', code: 'abc-123' });
  });
});

describe('isTaplineLink', () => {
  test('matches pairing and forget links, with or without the scheme', () => {
    expect(isTaplineLink(PAIR)).toBe(true);
    expect(isTaplineLink('myapp://tapline/forget')).toBe(true);
    expect(isTaplineLink('/tapline/pair?url=x&code=y')).toBe(true);
    expect(isTaplineLink('tapline/forget')).toBe(true);
  });

  test("leaves the app's own links alone", () => {
    for (const url of ['myapp://settings', '/', '/tapline-docs', 'https://example.com/tapline/pair', 'myapp://taplines/pair', 'myapp://tapline']) {
      expect(isTaplineLink(url)).toBe(false);
    }
  });
});
