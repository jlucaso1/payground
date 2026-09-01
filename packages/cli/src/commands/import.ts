import { importSnapshots } from '@payground/server/maintenance.ts';
import { FAILURE, OK, USAGE_ERROR, flag, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, type Env } from '../env.ts';
import { databasePath, message, openMigrated } from './db.ts';

export const IMPORT_USAGE = `Usage: payground import [options]

Restores an export into any instance. With --as the snapshot lands under a new sandbox id,
so it can sit next to the original; a token or public key already taken is minted afresh.
A restored delivery that was still queued or retrying is sent again by the running server.

  --db <path>       SQLite file to restore into, created if absent (default ${DEFAULT_DB})
  --in <file>       Export produced by \`payground export\` (required)
  --as <id>         Restore under this sandbox id (export must hold a single sandbox)
  --replace         Overwrite a sandbox that already exists
  -h, --help        Show this help`;

export async function runImport(argv: readonly string[], env: Env): Promise<number> {
  const parsed = parseOptions(argv, {
    db: { type: 'string' },
    in: { type: 'string' },
    as: { type: 'string' },
    replace: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(IMPORT_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(IMPORT_USAGE);
    return OK;
  }

  const source = text(parsed.values, 'in');
  if (source === undefined) {
    env.io.err('--in <file> is required');
    env.io.err(IMPORT_USAGE);
    return USAGE_ERROR;
  }

  const as = text(parsed.values, 'as');
  if (as !== undefined && as.trim() === '') {
    env.io.err('--as needs a sandbox id');
    return USAGE_ERROR;
  }

  let document: unknown;
  try {
    document = await Bun.file(source).json();
  } catch (error) {
    env.io.err(`cannot read the export at ${source}: ${message(error)}`);
    return FAILURE;
  }

  const opened = openMigrated(env, databasePath(parsed.values, env), true);
  if (!opened.ok) {
    env.io.err(opened.error);
    return FAILURE;
  }
  const db = opened.value;

  try {
    const result = importSnapshots(db, document, {
      replace: flag(parsed.values, 'replace'),
      uuid: () => env.uuid(),
      ...(as === undefined ? {} : { as }),
    });
    if (!result.ok) {
      env.io.err(result.error);
      return FAILURE;
    }
    for (const summary of result.value) {
      env.io.out(`imported ${summary.rows} rows into ${summary.sandbox}`);
      if (summary.regeneratedCredentials) {
        env.io.out(`  credentials regenerated: the exported token was already in use`);
      }
    }
    return OK;
  } finally {
    db.close();
  }
}
