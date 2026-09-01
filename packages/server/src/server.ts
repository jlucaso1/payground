import type { Clock } from '@payground/core';
import { type AppOptions, createApp } from './app.ts';
import { databaseOf } from './webhook/lease.ts';
import { instrument } from './parity/strict.ts';

export interface ServerOptions extends AppOptions {
  port?: number;
  hostname?: string;
  clock?: Clock;
  /**
   * Refuse requests the real Mercado Pago API would refuse, and record every response
   * that diverges from the specification. Off by default: payground is deliberately more
   * permissive than the real API.
   */
  strict?: boolean;
}

export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export type DrainOutcome = 'drained' | 'timeout';

export function createServer(options: ServerOptions = {}) {
  const app = createApp(options);
  const routes = instrument({ runtime: app.runtime, routes: app.routes, strict: options.strict ?? false });

  const server = Bun.serve({
    port: options.port ?? 8080,
    hostname: options.hostname ?? '127.0.0.1',
    routes: routes as never,
    fetch: () =>
      Response.json({ message: 'not found', error: 'not_found', status: 404 }, { status: 404 }),
  });

  // Hosted checkout and ticket URLs must point at the port we actually bound.
  if (options.baseUrl === undefined) app.runtime.baseUrl = server.url.origin;

  const stop = server.stop.bind(server);

  /** Leaves the WAL small enough that the next process opens quickly. Never fatal. */
  const checkpoint = (): void => {
    try {
      databaseOf(app.runtime.storage).exec('pragma wal_checkpoint(truncate)');
    } catch {
      /* a closed or in-memory database has nothing to checkpoint */
    }
  };

  return Object.assign(server, {
    app,
    stop: async (closeActive?: boolean) => {
      app.stop();
      await stop(closeActive);
    },
    /**
     * Stops accepting connections, lets in-flight requests finish, then checkpoints. Falls
     * back to cutting the remaining connections once the timeout expires.
     */
    drain: async (timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<DrainOutcome> => {
      app.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<DrainOutcome>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), Math.max(timeoutMs, 0));
      });
      const closed = stop(false).then((): DrainOutcome => 'drained', (): DrainOutcome => 'drained');
      const outcome = await Promise.race([closed, expired]);
      clearTimeout(timer);
      if (outcome === 'timeout') await stop(true);
      checkpoint();
      return outcome;
    },
  });
}
