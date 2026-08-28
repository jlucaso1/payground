import { type Clock, type IdGenerator, type Sandbox, sandboxId } from '@payground/core';
import {
  createPayment,
  createRefund,
  getPayment,
  listRefunds,
  searchPayments,
  updatePayment,
} from '@payground/mercadopago/api/payments.ts';
import { type EventSink, noopSink } from '@payground/mercadopago/api/context.ts';
import { Storage } from '@payground/storage';
import { health } from './health.ts';
import { type AppRuntime, endpoint, fromResult } from './http/handler.ts';
import { SystemIdGenerator, systemClock } from './runtime.ts';

export interface BootstrapSandbox {
  name?: string;
  accessToken?: string;
  publicKey?: string;
  webhookSecret?: string;
}

export interface AppOptions {
  storage?: Storage;
  clock?: Clock;
  ids?: IdGenerator;
  baseUrl?: string;
  events?: EventSink;
  /** Creates a ready-to-use sandbox on start. Pass false for a bare instance. */
  bootstrap?: BootstrapSandbox | false;
}

export interface App {
  runtime: AppRuntime;
  routes: Record<string, unknown>;
  defaultSandbox: Sandbox | null;
}

export function createApp(options: AppOptions = {}): App {
  const storage = options.storage ?? Storage.open();
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? new SystemIdGenerator();
  const runtime: AppRuntime = {
    storage,
    clock,
    ids,
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:8080',
    events: options.events ?? noopSink,
  };

  const defaultSandbox = options.bootstrap === false ? null : bootstrap(runtime, options.bootstrap ?? {});
  const startedAt = clock.now();

  const routes = {
    '/_payground/health': () => Response.json(health(clock, startedAt)),

    '/v1/payments': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createPayment(service, body)), {
        idempotency: 'required',
      }),
    },
    '/v1/payments/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchPayments(service, url.searchParams))),
    },
    '/v1/payments/:id': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getPayment(service, param(request, 'id'))),
      ),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updatePayment(service, param(request, 'id'), body)),
      ),
    },
    '/v1/payments/:id/refunds': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(createRefund(service, param(request, 'id'), body)),
        { idempotency: 'optional' },
      ),
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(listRefunds(service, param(request, 'id'))),
      ),
    },
  };

  return { runtime, routes, defaultSandbox };
}

/** Bun exposes matched path parameters on the request object. */
function param(request: Request, name: string): string {
  const params = (request as Request & { params?: Record<string, string> }).params;
  return params?.[name] ?? '';
}

function bootstrap(runtime: AppRuntime, options: BootstrapSandbox): Sandbox {
  const existing = runtime.storage.sandboxes.list()[0];
  if (existing !== undefined) return existing;

  const id = sandboxId(runtime.ids.uuid());
  const sandbox: Sandbox = {
    id,
    name: options.name ?? 'default',
    accessToken: options.accessToken ?? `TEST-${runtime.ids.uuid()}`,
    publicKey: options.publicKey ?? `TEST-${runtime.ids.uuid()}`,
    webhookSecret: options.webhookSecret ?? runtime.ids.uuid(),
    liveMode: false,
    createdAt: runtime.clock.now(),
  };
  runtime.storage.sandboxes.create(sandbox);
  return sandbox;
}
