import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Result, err, ok } from '@payground/core';
import { DEFAULT_DB, type Env, MEMORY } from '../env.ts';
import type { Values } from '../args.ts';

export function databasePath(values: Values, env: Env): string {
  const value = values['db'];
  return typeof value === 'string' ? value : (env.variables['PAYGROUND_DB'] ?? DEFAULT_DB);
}

/**
 * The maintenance commands work below the repositories, on a raw handle. Opening the
 * storage first applies the migrations, so the schema exists even on a brand new file.
 */
export function openMigrated(env: Env, path: string, create = false): Result<Database, string> {
  if (path === MEMORY) return err(`${MEMORY} holds nothing between processes; pass --db <file>`);
  // Creating it here would turn a typo in a backup cron into an empty, green artefact.
  if (!create && !existsSync(path)) return err(`no database at ${path}`);
  try {
    env.openStorage(path).close();
    return ok(env.openDatabase(path));
  } catch (error) {
    return err(`cannot open the database at ${path}: ${message(error)}`);
  }
}

export function ensureDirectory(path: string): void {
  const directory = dirname(path);
  if (directory !== '' && directory !== '.') mkdirSync(directory, { recursive: true });
}

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
