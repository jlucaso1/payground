export type JsonTokenType =
  | 'key'
  | 'string'
  | 'number'
  | 'literal'
  | 'punctuation'
  | 'plain';

export interface JsonToken {
  type: JsonTokenType;
  text: string;
}

const PUNCTUATION = new Set(['{', '}', '[', ']', ',', ':']);
const NUMBER_START = /[-\d]/;
const NUMBER_BODY = /[-+.\deE]/;

function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    i += 1;
    if (ch === '"') return i;
  }
  return text.length;
}

function isKey(text: string, from: number): boolean {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    return ch === ':';
  }
  return false;
}

/**
 * Splits pretty-printed JSON into typed tokens. The concatenation of every token
 * text always equals the input, so nothing is dropped and nothing is injected;
 * escaping is left to the renderer.
 */
export function highlightJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const push = (type: JsonTokenType, value: string): void => {
    if (value === '') return;
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.type === type && type === 'plain') last.text += value;
    else tokens.push({ type, text: value });
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '"') {
      const end = stringEnd(text, i);
      push(isKey(text, end) ? 'key' : 'string', text.slice(i, end));
      i = end;
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      push('punctuation', ch);
      i += 1;
      continue;
    }
    if (text.startsWith('true', i) || text.startsWith('null', i)) {
      push('literal', text.slice(i, i + 4));
      i += 4;
      continue;
    }
    if (text.startsWith('false', i)) {
      push('literal', 'false');
      i += 5;
      continue;
    }
    if (NUMBER_START.test(ch)) {
      let end = i + 1;
      while (end < text.length && NUMBER_BODY.test(text[end] ?? '')) end += 1;
      push('number', text.slice(i, end));
      i = end;
      continue;
    }
    push('plain', ch);
    i += 1;
  }

  return tokens;
}

export function prettyPrint(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
