import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SeededRandom } from '@payground/core/testing.ts';
import * as generated from '../../../packages/mercadopago/src/generated/validate.ts';
import { applyOverlay } from './gen.ts';
import { type JsonSchema, type OpenApiDocument, normalise, refName } from './schema.ts';

const doc = (await Bun.file(join(import.meta.dir, '../../../spec/spec3.json')).json()) as OpenApiDocument;
const schemas = applyOverlay(doc);

type Check = (value: unknown, path: string, out: generated.Issue[]) => void;
const checks = generated as unknown as Record<string, Check | undefined>;

const deref = (schema: JsonSchema): JsonSchema => {
  if (schema.$ref === undefined) return schema;
  const target = schemas[refName(schema.$ref)];
  if (target === undefined) throw new Error(`dangling ref ${schema.$ref}`);
  return deref(target);
};

function sample(schema: JsonSchema, rng: SeededRandom, depth = 0): unknown {
  const s = deref(schema);
  const { types, nullable } = normalise(s);
  if (nullable && rng.int(4) === 0) return null;

  if (s.enum !== undefined && s.enum.length > 0) return s.enum[rng.int(s.enum.length)];
  if (types.includes('array')) {
    if (s.items === undefined || depth > 4) return [];
    return Array.from({ length: rng.int(3) }, () => sample(s.items as JsonSchema, rng, depth + 1));
  }
  if (s.properties !== undefined) {
    const required = new Set(s.required ?? []);
    const out: Record<string, unknown> = {};
    for (const [name, prop] of Object.entries(s.properties)) {
      if (depth > 4 && !required.has(name)) continue;
      if (!required.has(name) && rng.int(3) === 0) continue;
      out[name] = sample(prop, rng, depth + 1);
    }
    return out;
  }
  if (types.includes('object')) return { anything: rng.int(100) };
  if (types.includes('string')) return `s${rng.int(1000)}`;
  if (types.includes('integer')) return (s.minimum ?? 0) + rng.int(1000);
  if (types.includes('number')) return (s.minimum ?? 0) + rng.int(1000) / 4;
  if (types.includes('boolean')) return rng.int(2) === 1;
  return { unconstrained: true };
}

/** Sites where the schema constrains the kind of a value, paired with a wrong-kind replacement. */
function sites(schema: JsonSchema, value: unknown, path: string[], depth = 0): { path: string[]; wrong: unknown }[] {
  if (depth > 5 || value === null) return [];
  const s = deref(schema);
  const { types } = normalise(s);
  const found: { path: string[]; wrong: unknown }[] = [];

  if (s.enum !== undefined && s.enum.length > 0) return [{ path, wrong: '__not_a_member__' }];
  if (types.includes('array') && Array.isArray(value)) {
    found.push({ path, wrong: { notAnArray: true } });
    if (s.items !== undefined) {
      value.forEach((item, i) => found.push(...sites(s.items as JsonSchema, item, [...path, String(i)], depth + 1)));
    }
    return found;
  }
  if (s.properties !== undefined) {
    if (typeof value !== 'object' || Array.isArray(value)) return found;
    found.push({ path, wrong: 'not-an-object' });
    for (const [name, prop] of Object.entries(s.properties)) {
      const child = (value as Record<string, unknown>)[name];
      if (child === undefined) continue;
      found.push(...sites(prop, child, [...path, name], depth + 1));
    }
    return found;
  }
  if (types.includes('string')) return [{ path, wrong: 42 }];
  if (types.includes('integer') || types.includes('number')) return [{ path, wrong: 'not-a-number' }];
  if (types.includes('boolean')) return [{ path, wrong: 'not-a-boolean' }];
  if (types.includes('object')) return [{ path, wrong: 'not-an-object' }];
  return [];
}

function setAt(root: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const clone = structuredClone(root) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (const segment of path.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>;
  cursor[path[path.length - 1] as string] = value;
  return clone;
}

const names = Object.keys(schemas).filter((n) => checks[`check${n}`] !== undefined);

describe('generated validators', () => {
  test('a validator exists for every schema', () => {
    expect(names.length).toBe(Object.keys(schemas).length);
  });

  test.each(names)('%s accepts schema-conforming samples', (name) => {
    const check = checks[`check${name}`] as Check;
    const rng = new SeededRandom(name.length + 1);
    for (let i = 0; i < 40; i++) {
      const value = sample(schemas[name] as JsonSchema, rng);
      const issues: generated.Issue[] = [];
      check(value, '', issues);
      expect({ name, value, issues }).toEqual({ name, value, issues: [] });
    }
  });

  test.each(names)('%s rejects a wrong-kind value at any constrained site', (name) => {
    const check = checks[`check${name}`] as Check;
    const rng = new SeededRandom(name.length + 7);
    for (let i = 0; i < 40; i++) {
      const value = sample(schemas[name] as JsonSchema, rng);
      const candidates = sites(schemas[name] as JsonSchema, value, []);
      if (candidates.length === 0) continue;
      const target = candidates[rng.int(candidates.length)] as { path: string[]; wrong: unknown };
      const issues: generated.Issue[] = [];
      check(setAt(value, target.path, target.wrong), '', issues);
      expect({ name, path: target.path, count: issues.length > 0 }).toEqual({
        name,
        path: target.path,
        count: true,
      });
    }
  });

  test.each(names)('%s reports every missing required property', (name) => {
    const schema = schemas[name] as JsonSchema;
    const required = schema.required ?? [];
    if (required.length === 0) return;
    const check = checks[`check${name}`] as Check;
    for (const missing of required) {
      const rng = new SeededRandom(missing.length + 3);
      const value = sample(schema, rng) as Record<string, unknown>;
      delete value[missing];
      const issues: generated.Issue[] = [];
      check(value, '', issues);
      expect(issues.map((issue) => issue.path)).toContain(`.${missing}`);
    }
  });
});
