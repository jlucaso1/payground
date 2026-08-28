import { type Sandbox, sandboxId } from '@payground/core';
import type { Storage } from '@payground/storage';
import { FAILURE, OK, USAGE_ERROR, flag, parseOptions, text } from '../args.ts';
import { DEFAULT_DB, type Env } from '../env.ts';

export const SANDBOX_USAGE = `Usage: payground sandbox <subcommand> [options]

  list                   List every sandbox
  create --name <name>   Create a sandbox and print its credentials
  show <id>              Show one sandbox, credentials included
  delete <id>            Delete a sandbox and all of its data

  --db <path>            SQLite file, or :memory: (default ${DEFAULT_DB}, env PAYGROUND_DB)
  -h, --help             Show this help`;

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

function describe(sandbox: Sandbox): string[] {
  return [
    `id              ${sandbox.id}`,
    `name            ${sandbox.name}`,
    `access token    ${sandbox.accessToken}`,
    `public key      ${sandbox.publicKey}`,
    `webhook secret  ${sandbox.webhookSecret}`,
    `live mode       ${sandbox.liveMode}`,
    `created at      ${iso(sandbox.createdAt)}`,
  ];
}

export function runSandbox(argv: readonly string[], env: Env): number {
  const parsed = parseOptions(
    argv,
    { db: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    true,
  );
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(SANDBOX_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(SANDBOX_USAGE);
    return OK;
  }

  const [subcommand, target] = parsed.positionals;
  if (subcommand === undefined) {
    env.io.err('missing subcommand');
    env.io.err(SANDBOX_USAGE);
    return USAGE_ERROR;
  }
  if (!['list', 'create', 'show', 'delete'].includes(subcommand)) {
    env.io.err(`unknown subcommand: ${subcommand}`);
    env.io.err(SANDBOX_USAGE);
    return USAGE_ERROR;
  }
  if (subcommand === 'create' && text(parsed.values, 'name') === undefined) {
    env.io.err('sandbox create requires --name');
    return USAGE_ERROR;
  }
  if ((subcommand === 'show' || subcommand === 'delete') && target === undefined) {
    env.io.err(`sandbox ${subcommand} requires an id`);
    return USAGE_ERROR;
  }

  const db = text(parsed.values, 'db') ?? env.variables['PAYGROUND_DB'] ?? DEFAULT_DB;
  let storage: Storage;
  try {
    storage = env.openStorage(db);
  } catch (error) {
    env.io.err(`cannot open the database at ${db}: ${error instanceof Error ? error.message : String(error)}`);
    return FAILURE;
  }

  try {
    switch (subcommand) {
      case 'list': {
        const sandboxes = storage.sandboxes.list();
        if (sandboxes.length === 0) {
          env.io.out('no sandboxes');
          return OK;
        }
        const width = Math.max(...sandboxes.map((sandbox) => sandbox.name.length));
        for (const sandbox of sandboxes) {
          env.io.out(`${sandbox.id}  ${sandbox.name.padEnd(width)}  ${sandbox.accessToken}  ${iso(sandbox.createdAt)}`);
        }
        return OK;
      }
      case 'create': {
        const created: Sandbox = {
          id: sandboxId(env.uuid()),
          name: text(parsed.values, 'name') as string,
          accessToken: `TEST-${env.uuid()}`,
          publicKey: `TEST-${env.uuid()}`,
          webhookSecret: env.uuid(),
          liveMode: false,
          createdAt: env.now(),
        };
        storage.sandboxes.create(created);
        for (const line of describe(created)) env.io.out(line);
        return OK;
      }
      case 'show': {
        const found = storage.sandboxes.get(sandboxId(target as string));
        if (found === null) {
          env.io.err(`sandbox not found: ${target}`);
          return FAILURE;
        }
        for (const line of describe(found)) env.io.out(line);
        return OK;
      }
      default: {
        const found = storage.sandboxes.get(sandboxId(target as string));
        if (found === null) {
          env.io.err(`sandbox not found: ${target}`);
          return FAILURE;
        }
        storage.sandboxes.reset(found.id);
        storage.sandboxes.remove(found.id);
        env.io.out(`deleted ${found.id}`);
        return OK;
      }
    }
  } finally {
    storage.close();
  }
}
