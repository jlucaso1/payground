import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { OVERLAY } from '../../../spec/overlay.ts';
import { emitRoutes } from './emit-routes.ts';
import { emitTypes } from './emit-types.ts';
import { emitValidators } from './emit-validate.ts';
import { applyOverlay, emitFidelity } from './gen.ts';
import type { OpenApiDocument } from './schema.ts';

const ROOT = join(import.meta.dir, '../../..');
const doc = (await Bun.file(join(ROOT, 'spec/spec3.json')).json()) as OpenApiDocument;

describe('overlay', () => {
  test('every entry targets a schema that exists upstream', () => {
    for (const entry of OVERLAY) expect(doc.components.schemas).toHaveProperty(entry.schema);
  });

  test('adds the Pix payload the spec omits', () => {
    expect(doc.components.schemas['Payment']?.properties).not.toHaveProperty('point_of_interaction');
    expect(applyOverlay(doc)['Payment']?.properties).toHaveProperty('point_of_interaction');
  });

  test('does not mutate the vendored document', () => {
    applyOverlay(doc);
    expect(doc.components.schemas['Payment']?.properties).not.toHaveProperty('live_mode');
  });

  test('fidelity notes cite a source and explain the gap', () => {
    const md = emitFidelity();
    for (const entry of OVERLAY) {
      expect(md).toContain(entry.source);
      expect(entry.note.length).toBeGreaterThan(30);
    }
  });
});

describe('committed output', () => {
  const schemas = applyOverlay(doc);
  const cases: [string, string][] = [
    ['packages/mercadopago/src/generated/types.ts', emitTypes(schemas)],
    ['packages/mercadopago/src/generated/validate.ts', emitValidators(schemas)],
    ['packages/mercadopago/src/generated/routes.ts', emitRoutes(doc)],
    ['FIDELITY.md', `${emitFidelity()}\n`],
  ];

  test.each(cases)('%s is up to date', async (path, expected) => {
    expect(await Bun.file(join(ROOT, path)).text()).toBe(expected);
  });
});

describe('vendored spec', () => {
  test('matches the recorded digest', async () => {
    const lock = (await Bun.file(join(ROOT, 'spec/spec.lock.json')).json()) as {
      sha256: Record<string, string>;
    };
    for (const [file, expected] of Object.entries(lock.sha256)) {
      const bytes = await Bun.file(join(ROOT, 'spec', file)).arrayBuffer();
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(expected);
    }
  });
});
