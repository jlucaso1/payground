import type { Clock } from '@payground/core';
import { systemClock } from './runtime.ts';
import { health } from './health.ts';

export interface ServerOptions {
  port?: number;
  hostname?: string;
  clock?: Clock;
}

export function createServer(options: ServerOptions = {}) {
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now();

  return Bun.serve({
    port: options.port ?? 8080,
    hostname: options.hostname ?? '127.0.0.1',
    routes: {
      '/_payground/health': () => Response.json(health(clock, startedAt)),
    },
    fetch: () =>
      Response.json({ message: 'not found', error: 'not_found', status: 404 }, { status: 404 }),
  });
}
