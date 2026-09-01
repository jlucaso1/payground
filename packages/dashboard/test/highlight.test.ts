import { describe, expect, test } from 'bun:test';
import { highlightJson, prettyPrint, type JsonToken } from '../src/lib/highlight.ts';

const join = (tokens: readonly JsonToken[]): string => tokens.map((t) => t.text).join('');
const typed = (tokens: readonly JsonToken[], type: string): string[] =>
  tokens.filter((t) => t.type === type).map((t) => t.text);

describe('highlightJson', () => {
  test('is lossless for any input', () => {
    const inputs = [
      '',
      '{}',
      '   ',
      'not json at all',
      '{"a":1}',
      prettyPrint({ a: [1, -2.5, 1e3], b: { c: true, d: false, e: null } }),
    ];
    for (const input of inputs) expect(join(highlightJson(input))).toBe(input);
  });

  test('separates keys from string values', () => {
    const tokens = highlightJson('{\n  "status": "approved"\n}');
    expect(typed(tokens, 'key')).toEqual(['"status"']);
    expect(typed(tokens, 'string')).toEqual(['"approved"']);
  });

  test('classifies numbers and literals', () => {
    const tokens = highlightJson('{"a": 1, "b": -2.5, "c": 1e3, "d": true, "e": false, "f": null}');
    expect(typed(tokens, 'number')).toEqual(['1', '-2.5', '1e3']);
    expect(typed(tokens, 'literal')).toEqual(['true', 'false', 'null']);
  });

  test('treats structural characters as punctuation', () => {
    const tokens = highlightJson('[{"a":[]}]');
    expect(typed(tokens, 'punctuation').join('')).toBe('[{:[]}]');
  });

  test('keeps escaped quotes inside a single string token', () => {
    const tokens = highlightJson('{"a": "he said \\"hi\\""}');
    expect(typed(tokens, 'string')).toEqual(['"he said \\"hi\\""']);
    expect(typed(tokens, 'key')).toEqual(['"a"']);
  });

  test('a trailing backslash cannot run past the end of the input', () => {
    expect(join(highlightJson('{"a": "unterminated\\'))).toBe('{"a": "unterminated\\');
  });

  test('an unterminated string is still a single token', () => {
    const tokens = highlightJson('{"a": "open');
    expect(typed(tokens, 'string')).toEqual(['"open']);
  });

  test('hostile values stay intact and are not treated as markup', () => {
    const doc = {
      note: '</script><img src=x onerror=alert(1)>',
      quoted: 'he said "hi"\nnew line\ttab',
      key: '{"nested": "json"}',
    };
    const text = prettyPrint(doc);
    const tokens = highlightJson(text);
    expect(join(tokens)).toBe(text);
    expect(typed(tokens, 'key')).toEqual(['"note"', '"quoted"', '"key"']);
    expect(tokens.some((t) => t.text.includes('</script>'))).toBe(true);
    for (const token of tokens) expect(text.includes(token.text)).toBe(true);
  });

  test('a key whose value looks like a colon is not confused', () => {
    const tokens = highlightJson('{"a": ":", "b": 1}');
    expect(typed(tokens, 'key')).toEqual(['"a"', '"b"']);
    expect(typed(tokens, 'string')).toEqual(['":"']);
  });

  test('unicode and emoji survive untouched', () => {
    const text = prettyPrint({ 'ção': 'café 😀' });
    expect(join(highlightJson(text))).toBe(text);
  });
});

describe('prettyPrint', () => {
  test('indents with two spaces', () => {
    expect(prettyPrint({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  test('falls back to a string for values JSON cannot represent', () => {
    expect(prettyPrint(undefined)).toBe('undefined');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(prettyPrint(cyclic)).toBe('[object Object]');
  });
});
