import type { Clock } from '@payground/core';
import { type AppOptions, createApp } from './app.ts';
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
  return Object.assign(server, {
    app,
    stop: async (closeActive?: boolean) => {
      app.stop();
      await stop(closeActive);
    },
  });
}
