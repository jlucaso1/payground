import { Storage } from '@payground/storage';
import { type Env, type Io, openDatabase, openStorage } from './env.ts';

export interface TestEnv {
  env: Env;
  storage: Storage;
  out: string[];
  err: string[];
}

/**
 * Commands close the database they open, so the shared in-memory instance is handed out
 * behind an object whose `close` does nothing. That keeps one database alive across the
 * several commands a test runs.
 *
 * `files: true` opts out of that: every command opens the real path it was given, which is
 * what the export, import, backup and prune commands need.
 */
export function testEnv(
  options: { now?: number; variables?: Record<string, string | undefined>; files?: boolean } = {},
): TestEnv {
  const storage = Storage.open();
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  let counter = 0;

  const env: Env = {
    io,
    variables: options.variables ?? {},
    openStorage: options.files === true
      ? openStorage
      : () => Object.create(storage, { close: { value: () => undefined } }) as Storage,
    openDatabase: options.files === true
      ? openDatabase
      : () => {
          throw new Error('testEnv: pass { files: true } to open a database');
        },
    now: () => options.now ?? 1_700_000_000_000,
    uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    waitForShutdown: () => Promise.resolve(),
  };

  return { env, storage, out, err };
}
