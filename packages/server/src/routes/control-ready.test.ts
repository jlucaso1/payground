import { describe, expect, test } from 'bun:test';
import { MIGRATIONS, Storage } from '@payground/storage';
import { controlReady, readiness } from './control-ready.ts';
import type { ModuleDeps, RouteTable } from './module.ts';

const probe = (storage: Storage): (() => Response) => {
  const routes: RouteTable = controlReady.routes({ storage } as ModuleDeps);
  return routes['/_payground/ready'] as () => Response;
};

describe('readiness', () => {
  test('reports the database and the applied migrations', () => {
    const storage = Storage.open();
    expect(readiness(storage)).toEqual({
      ready: true,
      checks: { database: true, migrations: true },
      migrations: { applied: MIGRATIONS.length, expected: MIGRATIONS.length },
    });
    storage.close();
  });

  test('answers 200 while the database is usable', async () => {
    const storage = Storage.open();
    const response = probe(storage)();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true });
    storage.close();
  });

  test('answers 503 once the database is gone', async () => {
    const storage = Storage.open();
    const handler = probe(storage);
    storage.close();

    const response = handler();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      checks: { database: false, migrations: false },
      migrations: { applied: 0, expected: MIGRATIONS.length },
    });
  });

  test('serves no spec operation', () => {
    expect(controlReady.operations).toEqual([]);
    expect(controlReady.pending).toEqual([]);
  });
});
