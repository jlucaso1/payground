import { describe, expect, test } from 'bun:test';
import { main } from '../index.ts';
import { testEnv } from '../testing.ts';

const count = (storage: ReturnType<typeof testEnv>['storage'], index: number): number => {
  const sandbox = storage.sandboxes.list()[index];
  if (sandbox === undefined) return 0;
  return storage.forSandbox(sandbox.id).payments.search({ limit: 1 }).total;
};

describe('reset', () => {
  test('drops the data but keeps the credentials', async () => {
    const { env, storage, out } = testEnv();
    await main(['seed'], env);
    const before = storage.sandboxes.list()[0];
    expect(count(storage, 0)).toBe(12);

    out.length = 0;
    expect(await main(['reset'], env)).toBe(0);
    expect(out).toEqual(['reset 1 sandbox']);
    expect(count(storage, 0)).toBe(0);
    expect(storage.sandboxes.list()[0]).toEqual(before);
  });

  test('resets a single sandbox when asked', async () => {
    const { env, storage } = testEnv();
    await main(['seed'], env);
    await main(['sandbox', 'create', '--name', 'other'], env);
    const second = storage.sandboxes.list()[1];
    if (second === undefined) throw new Error('expected two sandboxes');
    await main(['seed', '--db', ':memory:'], env);

    expect(await main(['reset', '--sandbox', second.id], env)).toBe(0);
    expect(count(storage, 0)).toBe(12);
    expect(count(storage, 1)).toBe(0);
  });

  test('fails when the sandbox does not exist', async () => {
    const { env, err } = testEnv();
    expect(await main(['reset', '--sandbox', 'nope'], env)).toBe(1);
    expect(err[0]).toBe('sandbox not found: nope');
  });

  test('reports zero when there is nothing to reset', async () => {
    const { env, out } = testEnv();
    expect(await main(['reset'], env)).toBe(0);
    expect(out).toEqual(['reset 0 sandboxes']);
  });
});
