import { describe, expect, test } from 'bun:test';
import { emitTypes, typeExpr } from './emit-types.ts';

describe('type emission', () => {
  test('maps primitives', () => {
    expect(typeExpr({ type: 'string' }, '')).toBe('string');
    expect(typeExpr({ type: 'integer' }, '')).toBe('number');
    expect(typeExpr({ type: 'number' }, '')).toBe('number');
    expect(typeExpr({ type: 'boolean' }, '')).toBe('boolean');
    expect(typeExpr({}, '')).toBe('unknown');
  });

  test('treats 3.0 nullable and 3.1 type arrays the same', () => {
    expect(typeExpr({ type: 'string', nullable: true }, '')).toBe('string | null');
    expect(typeExpr({ type: ['string', 'null'] }, '')).toBe('string | null');
  });

  test('emits enum unions', () => {
    expect(typeExpr({ type: 'string', enum: ['a', 'b'] }, '')).toBe('"a" | "b"');
  });

  test('parenthesises unions inside arrays', () => {
    expect(typeExpr({ type: 'array', items: { type: ['string', 'null'] } }, '')).toBe('(string | null)[]');
    expect(typeExpr({ type: 'array', items: { type: 'string' } }, '')).toBe('string[]');
  });

  test('resolves refs by name', () => {
    expect(typeExpr({ $ref: '#/components/schemas/Payer' }, '')).toBe('Payer');
  });

  test('marks non-required properties optional and quotes odd keys', () => {
    const out = typeExpr(
      { type: 'object', properties: { a: { type: 'string' }, 'x-y': { type: 'string' } }, required: ['a'] },
      '',
    );
    expect(out).toContain('a: string;');
    expect(out).toContain('"x-y"?: string;');
  });

  test('an object without properties degrades to a record', () => {
    expect(typeExpr({ type: 'object' }, '')).toBe('Record<string, unknown>');
  });

  test('emits interfaces for objects and aliases otherwise', () => {
    const src = emitTypes({
      Thing: { type: 'object', properties: { a: { type: 'string' } } },
      Name: { type: 'string' },
    });
    expect(src).toContain('export interface Thing {');
    expect(src).toContain('export type Name = string;');
  });
});
