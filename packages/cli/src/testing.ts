import { Storage } from '@payground/storage';
import type { Env, Io } from './env.ts';

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
 */
export function testEnv(options: { now?: number; variables?: Record<string, string | undefined> } = {}): TestEnv {
  const storage = Storage.open();
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  let counter = 0;

  const env: Env = {
    io,
    variables: options.variables ?? {},
    openStorage: () => Object.create(storage, { close: { value: () => undefined } }) as Storage,
    now: () => options.now ?? 1_700_000_000_000,
    uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    waitForShutdown: () => Promise.resolve(),
  };

  return { env, storage, out, err };
}
