import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { ROUTES } from '@payground/mercadopago/generated/routes.ts';
import { SCHEMAS, type SpecSchema, resolve } from './spec.ts';
import { validateNamed } from './validate.ts';

const SEED = 20_240_601;
const ROUNDS = 40;
const UNKNOWN = '__not_in_the_spec__';

const types = (schema: SpecSchema): string[] =>
  schema.type === undefined ? [] : typeof schema.type === 'string' ? [schema.type] : [...schema.type];

/** A value the specification accepts: every required property, some optional ones. */
function sample(schema: SpecSchema, random: SeededRandom, depth = 0): unknown {
  const resolved = resolve(schema);
  const allowed = types(resolved);
  if (allowed.includes('null') || resolved.nullable === true) {
    if (random.int(4) === 0) return null;
  }
  if (resolved.enum !== undefined && resolved.enum.length > 0) return resolved.enum[random.int(resolved.enum.length)];
  if (allowed.includes('array')) {
    const items = resolved.items;
    if (items === undefined || depth > 4) return [];
    return Array.from({ length: 1 + random.int(2) }, () => sample(items, random, depth + 1));
  }
  if (resolved.properties !== undefined) {
    const required = new Set(resolved.required ?? []);
    const out: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(resolved.properties)) {
      if (!required.has(name) && (depth > 4 || random.int(3) === 0)) continue;
      out[name] = sample(property, random, depth + 1);
    }
    return out;
  }
  if (allowed.includes('object')) return { free: random.int(100) };
  if (allowed.includes('string')) return `s${random.int(1000)}`;
  if (allowed.includes('integer')) return (resolved.minimum ?? 0) + random.int(1000);
  if (allowed.includes('number')) return (resolved.minimum ?? 0) + random.int(1000) / 4;
  if (allowed.includes('boolean')) return random.int(2) === 1;
  return { unconstrained: true };
}

interface Site {
  path: string[];
  wrong: unknown;
  closed: boolean;
}

/** Every place the schema constrains a value, with something the schema forbids there. */
function sites(schema: SpecSchema, value: unknown, path: string[], depth = 0): Site[] {
  if (depth > 5 || value === null) return [];
  const resolved = resolve(schema);
  const allowed = types(resolved);
  const found: Site[] = [];

  if (resolved.enum !== undefined && resolved.enum.length > 0) {
    return [{ path, wrong: UNKNOWN, closed: false }];
  }
  if (Array.isArray(value)) {
    const items = resolved.items;
    if (items !== undefined) {
      value.forEach((entry, index) => found.push(...sites(items, entry, [...path, String(index)], depth + 1)));
    }
    return found;
  }
  if (resolved.properties !== undefined) {
    if (typeof value !== 'object') return found;
    found.push({ path, wrong: 'not-an-object', closed: resolved.additionalProperties !== true });
    for (const [name, property] of Object.entries(resolved.properties)) {
      const child = (value as Record<string, unknown>)[name];
      if (child === undefined) continue;
      found.push(...sites(property, child, [...path, name], depth + 1));
    }
    return found;
  }
  if (allowed.includes('string')) return [{ path, wrong: 42, closed: false }];
  if (allowed.includes('integer') || allowed.includes('number')) return [{ path, wrong: 'not-a-number', closed: false }];
  if (allowed.includes('boolean')) return [{ path, wrong: 'not-a-boolean', closed: false }];
  return found;
}

function at(root: unknown, path: readonly string[]): Record<string, unknown> {
  let cursor = root as Record<string, unknown>;
  for (const segment of path) cursor = cursor[segment] as Record<string, unknown>;
  return cursor;
}

function setAt(root: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const clone = structuredClone(root);
  at(clone, path.slice(0, -1))[path[path.length - 1] as string] = value;
  return clone;
}

const names = [...new Set(ROUTES.map((route) => route.requestSchema))]
  .filter((name): name is string => name !== undefined && SCHEMAS[name] !== undefined)
  .sort();

describe('strict mode', () => {
  test('every documented request body has a schema to validate against', () => {
    expect(names.length).toBeGreaterThan(10);
  });

  test.each(names)('%s: never rejects a body the specification accepts', (name) => {
    const schema = SCHEMAS[name] as SpecSchema;
    const random = new SeededRandom(SEED + name.length);
    for (let round = 0; round < ROUNDS; round += 1) {
      const body = sample(schema, random);
      expect({ name, body, issues: validateNamed(name, body) }).toEqual({ name, body, issues: [] });
    }
  });

  test.each(names)('%s: never accepts an undocumented field', (name) => {
    const schema = SCHEMAS[name] as SpecSchema;
    const random = new SeededRandom(SEED + 1 + name.length);
    for (let round = 0; round < ROUNDS; round += 1) {
      const body = sample(schema, random);
      const closed = sites(schema, body, []).filter((site) => site.closed);
      if (closed.length === 0) continue;
      const target = closed[random.int(closed.length)] as Site;
      const mutated = structuredClone(body);
      at(mutated, target.path)[UNKNOWN] = 1;
      const issues = validateNamed(name, mutated);
      expect({ name, path: target.path, issues }).toMatchObject({
        name,
        path: target.path,
        issues: [{ message: 'not documented by the specification' }],
      });
      expect(issues[0]?.path.endsWith(UNKNOWN)).toBe(true);
    }
  });

  test.each(names)('%s: never accepts a value of the wrong kind', (name) => {
    const schema = SCHEMAS[name] as SpecSchema;
    const random = new SeededRandom(SEED + 2 + name.length);
    for (let round = 0; round < ROUNDS; round += 1) {
      const body = sample(schema, random);
      const candidates = sites(schema, body, []).filter((site) => site.path.length > 0);
      if (candidates.length === 0) continue;
      const target = candidates[random.int(candidates.length)] as Site;
      const mutated = setAt(body, target.path, target.wrong);
      expect({ name, path: target.path, rejected: validateNamed(name, mutated).length > 0 }).toEqual({
        name,
        path: target.path,
        rejected: true,
      });
    }
  });

  test.each(names)('%s: never accepts a body missing a required field', (name) => {
    const schema = SCHEMAS[name] as SpecSchema;
    const required = resolve(schema).required ?? [];
    const random = new SeededRandom(SEED + 3 + name.length);
    for (const missing of required) {
      const body = sample(schema, random) as Record<string, unknown>;
      delete body[missing];
      expect({ name, missing, rejected: validateNamed(name, body).length > 0 }).toEqual({
        name,
        missing,
        rejected: true,
      });
    }
  });
});
