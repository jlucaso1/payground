import { sandboxId } from '@payground/core';
import type { Storage } from '@payground/storage';
import { FAILURE, OK, USAGE_ERROR, flag, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, type Env } from '../env.ts';

export const RESET_USAGE = `Usage: payground reset [options]

Deletes payments, refunds, webhooks and idempotency keys. Credentials survive.

  --db <path>       SQLite file, or :memory: (default ${DEFAULT_DB}, env PAYGROUND_DB)
  --sandbox <id>    Reset one sandbox instead of every sandbox
  -h, --help        Show this help`;

export function runReset(argv: readonly string[], env: Env): number {
  const parsed = parseOptions(argv, {
    db: { type: 'string' },
    sandbox: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(RESET_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(RESET_USAGE);
    return OK;
  }

  const db = text(parsed.values, 'db') ?? env.variables['PAYGROUND_DB'] ?? DEFAULT_DB;
  const only = text(parsed.values, 'sandbox');

  let storage: Storage;
  try {
    storage = env.openStorage(db);
  } catch (error) {
    env.io.err(`cannot open the database at ${db}: ${error instanceof Error ? error.message : String(error)}`);
    return FAILURE;
  }

  try {
    const targets =
      only === undefined
        ? storage.sandboxes.list()
        : [storage.sandboxes.get(sandboxId(only))].filter((sandbox) => sandbox !== null);

    if (only !== undefined && targets.length === 0) {
      env.io.err(`sandbox not found: ${only}`);
      return FAILURE;
    }

    for (const sandbox of targets) storage.sandboxes.reset(sandbox.id);
    env.io.out(`reset ${targets.length} sandbox${targets.length === 1 ? '' : 'es'}`);
    return OK;
  } finally {
    storage.close();
  }
}
