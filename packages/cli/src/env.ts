import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Storage } from '@payground/storage';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export interface Env {
  io: Io;
  variables: Record<string, string | undefined>;
  openStorage(path: string): Storage;
  now(): number;
  uuid(): string;
  /** Resolves when the process should shut down. */
  waitForShutdown(url: string): Promise<void>;
}

export const MEMORY = ':memory:';
export const DEFAULT_DB = '.payground/payground.sqlite';

export function openStorage(path: string): Storage {
  if (path !== MEMORY) {
    const directory = dirname(path);
    if (directory !== '' && directory !== '.') mkdirSync(directory, { recursive: true });
  }
  return Storage.open({ path });
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export function defaultEnv(): Env {
  return {
    io: { out: (line) => console.log(line), err: (line) => console.error(line) },
    variables: process.env,
    openStorage,
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    waitForShutdown: untilSignal,
  };
}
