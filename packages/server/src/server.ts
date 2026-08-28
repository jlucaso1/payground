import type { Clock } from '@payground/core';
import { type AppOptions, createApp } from './app.ts';

export interface ServerOptions extends AppOptions {
  port?: number;
  hostname?: string;
  clock?: Clock;
}

export function createServer(options: ServerOptions = {}) {
  const app = createApp(options);

  const server = Bun.serve({
    port: options.port ?? 8080,
    hostname: options.hostname ?? '127.0.0.1',
    routes: app.routes as never,
    fetch: () =>
      Response.json({ message: 'not found', error: 'not_found', status: 404 }, { status: 404 }),
  });

  return Object.assign(server, { app });
}
