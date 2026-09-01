import { resolve } from 'node:path';
import { backup } from '@payground/server/maintenance.ts';
import { FAILURE, OK, USAGE_ERROR, flag, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, type Env } from '../env.ts';
import { databasePath, ensureDirectory, message, openMigrated } from './db.ts';

export const BACKUP_USAGE = `Usage: payground backup [options]

Writes a consistent snapshot of the whole database, safe to take while the server runs.
The result is a plain SQLite file: restore it by putting it back at --db.

  --db <path>       SQLite file to snapshot (default ${DEFAULT_DB}, env PAYGROUND_DB)
  --out <file>      Where to write the snapshot (required)
  -h, --help        Show this help`;

export async function runBackup(argv: readonly string[], env: Env): Promise<number> {
  const parsed = parseOptions(argv, {
    db: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(BACKUP_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(BACKUP_USAGE);
    return OK;
  }

  const out = text(parsed.values, 'out');
  if (out === undefined) {
    env.io.err('--out <file> is required');
    env.io.err(BACKUP_USAGE);
    return USAGE_ERROR;
  }

  const db = databasePath(parsed.values, env);
  const reserved = [db, `${db}-wal`, `${db}-shm`].map((path) => resolve(path));
  if (reserved.includes(resolve(out))) {
    env.io.err('--out would overwrite the database it reads; pick another path');
    return USAGE_ERROR;
  }

  const opened = openMigrated(env, db);
  if (!opened.ok) {
    env.io.err(opened.error);
    return FAILURE;
  }
  const handle = opened.value;

  try {
    // serialize() reads through the pager, so uncheckpointed WAL frames are included.
    const bytes = backup(handle);
    ensureDirectory(out);
    await Bun.write(out, bytes);
    env.io.out(`wrote ${bytes.byteLength} bytes to ${out}`);
    return OK;
  } catch (error) {
    env.io.err(`backup failed: ${message(error)}`);
    return FAILURE;
  } finally {
    handle.close();
  }
}
