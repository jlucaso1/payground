import type { ParityReport } from '@payground/server/parity/report.ts';
import { buildReport, readHistory } from '@payground/server/parity/report.ts';
import { existsSync } from 'node:fs';
import type { Storage } from '@payground/storage';
import { FAILURE, OK, USAGE_ERROR, flag, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, MEMORY, type Env } from '../env.ts';

export const DOCTOR_USAGE = `Usage: payground doctor [options]

Replays the recorded request history against the vendored Mercado Pago specification and
reports what would break when the same integration points at https://api.mercadopago.com.

  --db <path>       SQLite file, or :memory: (default ${DEFAULT_DB}, env PAYGROUND_DB)
  --sandbox <id>    Only look at the calls of one sandbox
  --format <fmt>    text (default) or json
  -h, --help        Show this help

Exits 1 when there are blocking findings, so it can gate a pipeline.`;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function render(report: ParityReport, database: string): string[] {
  const lines: string[] = [`payground doctor — ${plural(report.requests, 'request')} recorded in ${database}`];
  if (report.sandbox !== null) lines.push(`sandbox ${report.sandbox}`);

  lines.push('', 'Operations used');
  if (report.operations.length === 0) lines.push('  none — the history holds no call to a documented endpoint');
  for (const operation of report.operations) {
    const state = operation.state === 'emulated' ? 'emulated' : 'PENDING ';
    const reason = operation.state === 'pending' && operation.reason !== undefined ? `: ${operation.reason}` : '';
    lines.push(`  ${operation.operationId.padEnd(28)} ${String(operation.calls).padStart(4)}  ${state} (${operation.module})${reason}`);
  }

  if (report.rejected.length > 0) {
    lines.push('', 'Requests the real API would reject');
    for (const rejection of report.rejected) {
      lines.push(`  ${rejection.method} ${rejection.route}  ${plural(rejection.calls, 'call')}  (${rejection.schema})`);
      for (const issue of rejection.issues) lines.push(`    ${issue.path} — ${issue.message}`);
    }
  }

  if (report.responseDrift.length > 0) {
    lines.push('', 'Responses payground emits that the specification does not describe');
    for (const drift of report.responseDrift) {
      lines.push(`  ${drift.operationId} ${drift.status}  ${plural(drift.calls, 'call')}`);
      for (const issue of drift.issues) lines.push(`    ${issue.path} — ${issue.message}`);
    }
  }

  if (report.undocumented.length > 0) {
    lines.push('', 'Routes outside the specification');
    for (const route of report.undocumented) lines.push(`  ${route.method} ${route.route}  ${plural(route.calls, 'call')}`);
  }

  if (report.divergences.length > 0) {
    lines.push('', 'Known divergences you are exposed to');
    for (const divergence of report.divergences) {
      lines.push(`  ${divergence.area} — ${divergence.summary}`);
      lines.push(`    ${divergence.source}`);
    }
  }

  lines.push('');
  if (!report.verdict.blocking) {
    lines.push('Verdict: nothing blocking. Every endpoint you used is emulated faithfully and every');
    lines.push('body you sent is one the real API accepts.');
  } else {
    lines.push(
      `Verdict: ${plural(report.verdict.findings.length, 'blocking finding')} — this breaks against https://api.mercadopago.com:`,
    );
    for (const finding of report.verdict.findings) lines.push(`  - ${finding}`);
  }
  return lines;
}

export function runDoctor(argv: readonly string[], env: Env): number {
  const parsed = parseOptions(argv, {
    db: { type: 'string' },
    sandbox: { type: 'string' },
    format: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(DOCTOR_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(DOCTOR_USAGE);
    return OK;
  }

  const format = text(parsed.values, 'format') ?? 'text';
  if (format !== 'text' && format !== 'json') {
    env.io.err('--format must be text or json');
    return USAGE_ERROR;
  }

  const db = text(parsed.values, 'db') ?? env.variables['PAYGROUND_DB'] ?? DEFAULT_DB;
  // A gate must not pass because it was pointed at a database that was never written.
  if (db !== MEMORY && !existsSync(db)) {
    env.io.err(`no database at ${db}; point --db at the file \`payground start\` wrote`);
    return FAILURE;
  }
  let storage: Storage;
  try {
    storage = env.openStorage(db);
  } catch (error) {
    env.io.err(`cannot open the database at ${db}: ${error instanceof Error ? error.message : String(error)}`);
    return FAILURE;
  }

  try {
    const sandbox = text(parsed.values, 'sandbox') ?? null;
    if (sandbox !== null && storage.sandboxes.get(sandbox as never) === null) {
      env.io.err(`sandbox not found: ${sandbox}`);
      return FAILURE;
    }
    const now = env.now();
    const report = buildReport({ entries: readHistory(storage.requests, sandbox, now), now, sandbox });
    if (format === 'json') env.io.out(JSON.stringify(report, null, 2));
    else for (const line of render(report, db)) env.io.out(line);
    return report.verdict.blocking ? FAILURE : OK;
  } finally {
    storage.close();
  }
}
