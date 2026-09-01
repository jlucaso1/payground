import { PRUNE_CATEGORIES, type PruneCategory, prune } from '@payground/server/maintenance.ts';
import { FAILURE, OK, USAGE_ERROR, flag, integer, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, type Env } from '../env.ts';
import { databasePath, message, openMigrated } from './db.ts';

export const PRUNE_USAGE = `Usage: payground prune [options]

Deletes rows older than the given age, in days, and reports how many per table. A shared
instance needs this: request bodies and webhook attempts otherwise grow forever.

  --db <path>       SQLite file (default ${DEFAULT_DB}, env PAYGROUND_DB)
  --requests <days> Prune the API request history
  --audit <days>    Prune the audit log
  --webhooks <days> Prune delivered and exhausted webhooks, and their attempts
  --payments <days> Prune payments, their timelines and their refunds
  --dry-run         Report what would go, delete nothing
  -h, --help        Show this help`;

export function runPrune(argv: readonly string[], env: Env): number {
  const parsed = parseOptions(argv, {
    db: { type: 'string' },
    requests: { type: 'string' },
    audit: { type: 'string' },
    webhooks: { type: 'string' },
    payments: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(PRUNE_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(PRUNE_USAGE);
    return OK;
  }

  const days: Partial<Record<PruneCategory, number>> = {};
  for (const category of PRUNE_CATEGORIES) {
    const raw = text(parsed.values, category);
    if (raw === undefined) continue;
    const parsedDays = integer(raw, category, 0, 3650);
    if (!parsedDays.ok) {
      env.io.err(parsedDays.message);
      return USAGE_ERROR;
    }
    days[category] = parsedDays.value;
  }
  if (Object.keys(days).length === 0) {
    env.io.err('nothing to prune: pass at least one of --requests, --audit, --webhooks, --payments');
    env.io.err(PRUNE_USAGE);
    return USAGE_ERROR;
  }

  const opened = openMigrated(env, databasePath(parsed.values, env));
  if (!opened.ok) {
    env.io.err(opened.error);
    return FAILURE;
  }
  const db = opened.value;

  try {
    const dryRun = flag(parsed.values, 'dry-run');
    const report = prune(db, { now: env.now(), dryRun, days });
    env.io.out(dryRun ? `would delete ${report.total} rows` : `deleted ${report.total} rows`);
    for (const entry of report.deleted) env.io.out(`  ${entry.table.padEnd(20)} ${entry.rows}`);
    return OK;
  } catch (error) {
    env.io.err(`prune failed: ${message(error)}`);
    return FAILURE;
  } finally {
    db.close();
  }
}
