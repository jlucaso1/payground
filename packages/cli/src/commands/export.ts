import { rmSync } from 'node:fs';
import { exportSandboxes } from '@payground/server/maintenance.ts';
import { FAILURE, OK, USAGE_ERROR, flag, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, type Env } from '../env.ts';
import { databasePath, ensureDirectory, message, openMigrated } from './db.ts';

export const EXPORT_USAGE = `Usage: payground export [options]

Writes a self-describing JSON snapshot of the sandboxes: credentials, payments, their
timelines, refunds, documents, webhook deliveries and attempts. Request and audit logs
are not part of it, they are operational noise, not sandbox state.

  --db <path>       SQLite file (default ${DEFAULT_DB}, env PAYGROUND_DB)
  --sandbox <id>    Export one sandbox instead of every sandbox
  --out <file>      Write there instead of stdout
  -h, --help        Show this help`;

export async function runExport(argv: readonly string[], env: Env): Promise<number> {
  const parsed = parseOptions(argv, {
    db: { type: 'string' },
    sandbox: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(EXPORT_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(EXPORT_USAGE);
    return OK;
  }

  const opened = openMigrated(env, databasePath(parsed.values, env));
  if (!opened.ok) {
    env.io.err(opened.error);
    return FAILURE;
  }
  const db = opened.value;

  const out = text(parsed.values, 'out');
  const sandbox = text(parsed.values, 'sandbox');
  // Opened on the first chunk, so a rejected export leaves no half-written file behind.
  const target: { sink: ReturnType<typeof Bun.stdout.writer> | null } = { sink: null };
  const open = (): ReturnType<typeof Bun.stdout.writer> => {
    if (target.sink === null) {
      if (out !== undefined) ensureDirectory(out);
      target.sink = out === undefined ? Bun.stdout.writer() : Bun.file(out).writer();
    }
    return target.sink;
  };

  let failed = false;
  try {
    const result = exportSandboxes(db, {
      now: env.now(),
      write: (chunk) => void open().write(chunk),
      ...(sandbox === undefined ? {} : { sandbox }),
    });
    if (!result.ok) {
      env.io.err(result.error);
      return FAILURE;
    }
    if (out !== undefined) {
      env.io.out(`exported ${result.value.sandboxes} sandbox${result.value.sandboxes === 1 ? '' : 'es'} and ${result.value.rows} rows to ${out}`);
    }
    return OK;
  } catch (error) {
    env.io.err(`export failed: ${message(error)}`);
    failed = true;
    return FAILURE;
  } finally {
    if (target.sink !== null) await target.sink.end();
    // A half-written snapshot is worse than none: it would fail on import, much later.
    if (failed && out !== undefined) rmSync(out, { force: true });
    db.close();
  }
}
