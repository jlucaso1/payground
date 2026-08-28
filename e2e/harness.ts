import { createServer } from '@payground/server';

export interface Harness {
  url: string;
  stop(): Promise<void>;
}

/**
 * Starts payground and repoints the already-imported SDK at it. The preload runs before
 * the port is known, so the base URL is set again here against the live server.
 */
export async function startHarness(): Promise<Harness> {
  const server = createServer({ port: 0 });
  const { AppConfig } = (await import('mercadopago/dist/utils/config')) as {
    AppConfig: { BASE_URL: string };
  };
  AppConfig.BASE_URL = server.url.origin;

  return {
    url: server.url.origin,
    stop: async () => {
      await server.stop(true);
    },
  };
}
