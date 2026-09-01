#!/usr/bin/env bun
import { VERSION } from '@payground/server';
import { OK, USAGE_ERROR, flag, parseOptions } from './args.ts';
import { type Env, defaultEnv } from './env.ts';
import { runBackup } from './commands/backup.ts';
import { runBuildDashboard } from './commands/build-dashboard.ts';
import { runExport } from './commands/export.ts';
import { runImport } from './commands/import.ts';
import { runPrune } from './commands/prune.ts';
import { runReset } from './commands/reset.ts';
import { runSandbox } from './commands/sandbox.ts';
import { runSeed } from './commands/seed.ts';
import { runStart } from './commands/start.ts';

export const USAGE = `payground ${VERSION} — a stateful sandbox that speaks the Mercado Pago API

Usage: payground <command> [options]

  start             Run the sandbox server
  seed              Write deterministic sample payments
  reset             Delete the data of one or every sandbox
  sandbox           list | create --name <name> | show <id> | delete <id>
  export            Write a JSON snapshot of the sandboxes
  import            Restore a JSON snapshot into an instance
  backup            Write a consistent copy of the whole database
  prune             Delete rows older than a given age
  build-dashboard   Build the dashboard assets

  -h, --help        Show this help
  -v, --version     Show the version

Run \`payground <command> --help\` for the options of a command.
Exit codes: 0 success, 1 failure, 2 bad usage.`;

export async function main(argv: readonly string[], env: Env = defaultEnv()): Promise<number> {
  const command = argv[0];

  if (command === undefined || command.startsWith('-')) {
    const parsed = parseOptions(argv, {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    });
    if (!parsed.ok) {
      env.io.err(parsed.message);
      env.io.err(USAGE);
      return USAGE_ERROR;
    }
    if (flag(parsed.values, 'version')) {
      env.io.out(VERSION);
      return OK;
    }
    if (flag(parsed.values, 'help')) {
      env.io.out(USAGE);
      return OK;
    }
    env.io.err('missing command');
    env.io.err(USAGE);
    return USAGE_ERROR;
  }

  const rest = argv.slice(1);
  switch (command) {
    case 'start':
      return await runStart(rest, env);
    case 'seed':
      return runSeed(rest, env);
    case 'reset':
      return runReset(rest, env);
    case 'sandbox':
      return runSandbox(rest, env);
    case 'export':
      return await runExport(rest, env);
    case 'import':
      return await runImport(rest, env);
    case 'backup':
      return await runBackup(rest, env);
    case 'prune':
      return runPrune(rest, env);
    case 'build-dashboard':
      return await runBuildDashboard(rest, env);
    default:
      env.io.err(`unknown command: ${command}`);
      env.io.err(USAGE);
      return USAGE_ERROR;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
