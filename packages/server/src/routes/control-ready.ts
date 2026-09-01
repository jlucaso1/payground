import { MIGRATIONS, type Storage } from '@payground/storage';
import { databaseOf } from '../webhook/lease.ts';
import type { RouteModule } from './module.ts';

export interface Readiness {
  ready: boolean;
  checks: { database: boolean; migrations: boolean };
  migrations: { applied: number; expected: number };
}

/** Liveness stays cheap in `/_payground/health`; readiness is the one that touches the database. */
export function readiness(storage: Storage): Readiness {
  let database = false;
  let applied = 0;
  try {
    const db = databaseOf(storage);
    database = db.query<{ one: number }, []>('select 1 as one').get()?.one === 1;
    applied = db.query<{ n: number }, []>('select count(*) as n from schema_migrations').get()?.n ?? 0;
  } catch {
    /* an unusable database is exactly what "not ready" means */
  }
  const migrations = applied >= MIGRATIONS.length;
  return { ready: database && migrations, checks: { database, migrations }, migrations: { applied, expected: MIGRATIONS.length } };
}

/** Readiness probe. Control routes serve no spec operation, so both lists stay empty. */
export const controlReady: RouteModule = {
  name: 'control-ready',
  operations: [],
  pending: [],
  routes: ({ storage }) => ({
    '/_payground/ready': () => {
      const report = readiness(storage);
      return Response.json(report, { status: report.ready ? 200 : 503 });
    },
  }),
};
