import {
  type Clock,
  type IdGenerator,
  type MetricsSink,
  type RandomSource,
  type RateLimiter,
  type Sandbox,
  noopRateLimiter,
  sandboxId,
} from '@payground/core';
import type { EventSink } from '@payground/mercadopago/api/context.ts';
import { Storage } from '@payground/storage';
import { dashboardHandler } from './dashboard.ts';
import { MetricsRegistry } from './metrics/index.ts';
import { health } from './health.ts';
import * as control from './control/api.ts';
import { requireAdmin } from './control/auth.ts';
import { MODULES } from './routes/index.ts';
import type { ModuleDeps } from './routes/module.ts';
import { type AppRuntime, contextFor } from './http/handler.ts';
import { drain } from './webhook/runner.ts';
import { SystemIdGenerator, systemClock, systemRandom } from './runtime.ts';

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
  random?: RandomSource;
  /** Milliseconds between webhook queue drains. 0 disables the runner (tests drive it). */
  deliveryIntervalMs?: number;
  /**
   * Self-host defaults to allowing webhook targets on private addresses — delivering to
   * localhost is the point. A public multi-tenant deployment must set this to false so
   * user-supplied URLs cannot reach internal services.
   */
  allowPrivateWebhookTargets?: boolean;
  metrics?: MetricsSink;
  rateLimiter?: RateLimiter;
  /** Response bodies longer than this are not kept in the request history. 0 disables it. */
  historyBodyLimit?: number;
  /**
   * Gates the whole control API. Null or empty leaves it open, which is only safe for a
   * private local instance — a shared one must set it.
   */
  adminToken?: string | null;
  /** Directory holding the prebuilt dashboard. Omitted means the dashboard is not served. */
  dashboardRoot?: string;
  /** Creates a ready-to-use sandbox on start. Pass false for a bare instance. */
  bootstrap?: BootstrapSandbox | false;
}

export interface App {
  runtime: AppRuntime;
  adminToken: string | null;
  metrics: MetricsSink;
  routes: Record<string, unknown>;
  defaultSandbox: Sandbox | null;
  /** Delivers everything currently due. Exposed so tests never need to wait. */
  drainWebhooks(): Promise<number>;
  stop(): void;
}

export function createApp(options: AppOptions = {}): App {
  const storage = options.storage ?? Storage.open();
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? new SystemIdGenerator();
  const random = options.random ?? systemRandom;
  const metrics = options.metrics ?? new MetricsRegistry();
  const runtime: AppRuntime = {
    storage,
    clock,
    ids,
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:8080',
    random,
    metrics,
    requests: storage.requests,
    audit: storage.audit,
    rateLimiter: options.rateLimiter ?? noopRateLimiter,
    historyBodyLimit: options.historyBodyLimit ?? 16_384,
    ...(options.events === undefined ? {} : { events: options.events }),
  };

  const drainWebhooks = (): Promise<number> =>
    drain(storage.queue, (delivery) => storage.forSandbox(delivery.sandbox), {
      store: storage.forSandbox(sandboxId('unused')),
      clock,
      random,
      net: { allowPrivateAddresses: options.allowPrivateWebhookTargets ?? true },
    });

  const defaultSandbox = options.bootstrap === false ? null : bootstrap(runtime, options.bootstrap ?? {});
  const startedAt = clock.now();

  const deps: control.ControlDeps = {
    storage,
    now: () => clock.now(),
    uuid: () => ids.uuid(),
    notify: (sandbox, action, dataId, notificationUrl) => {
      contextFor(runtime, sandbox).events.emit({ type: 'payment', action, dataId, notificationUrl });
    },
  };
  const send = (result: control.ControlResult) => Response.json(result.body, { status: result.status });
  const path = (request: Request, name: string): string => param(request, name);

  const adminToken = options.adminToken === undefined ? null : options.adminToken;

  /** Everything under /_payground except health and the dashboard shell needs the token. */
  const admin =
    (handler: (request: Request) => Response | Promise<Response>) =>
    (request: Request): Response | Promise<Response> => {
      const denial = requireAdmin(request, new URL(request.url), adminToken);
      return denial === null ? handler(request) : Response.json(denial.body, { status: denial.status });
    };

  const routes: Record<string, unknown> = {
    '/_payground/health': () => Response.json(health(clock, startedAt)),
    ...(options.dashboardRoot === undefined
      ? {}
      : {
          '/_payground': dashboardHandler(options.dashboardRoot),
          '/_payground/assets/*': dashboardHandler(options.dashboardRoot),
        }),

    '/_payground/sandboxes': {
      GET: admin(() => send(control.listSandboxes(deps))),
      POST: admin(async (request) => send(control.createSandbox(deps, await json(request)))),
    },
    '/_payground/sandboxes/:id': {
      GET: admin((request) => send(control.getSandbox(deps, path(request, 'id')))),
      DELETE: admin((request) => send(control.deleteSandbox(deps, path(request, 'id')))),
    },
    '/_payground/sandboxes/:id/reset': {
      POST: admin((request) => send(control.resetSandbox(deps, path(request, 'id')))),
    },
    '/_payground/sandboxes/:id/payments': {
      GET: admin((request) =>
        send(control.listPayments(deps, path(request, 'id'), new URL(request.url).searchParams)),
      ),
    },
    '/_payground/sandboxes/:id/payments/:pid': {
      GET: admin((request) => send(control.getPaymentDetail(deps, path(request, 'id'), path(request, 'pid')))),
    },
    '/_payground/sandboxes/:id/payments/:pid/actions': {
      POST: admin(async (request) =>
        send(control.actOnPayment(deps, path(request, 'id'), path(request, 'pid'), await json(request))),
      ),
    },
    '/_payground/sandboxes/:id/webhooks': {
      GET: admin((request) => send(control.listWebhooks(deps, path(request, 'id')))),
    },
    '/_payground/sandboxes/:id/webhooks/:wid/replay': {
      POST: admin(async (request) => {
        const result = control.replayWebhook(deps, path(request, 'id'), path(request, 'wid'));
        if (result.status === 200) await drainWebhooks();
        return send(result);
      }),
    },
    '/_payground/sandboxes/:id/faults': {
      GET: admin((request) => send(control.getFaults(deps, path(request, 'id')))),
      PUT: admin(async (request) => send(control.setFaults(deps, path(request, 'id'), await json(request)))),
    },
  };

  const moduleDeps: ModuleDeps = { runtime, storage, admin, param, json };
  for (const module of MODULES) Object.assign(routes, module.routes(moduleDeps));

  const interval = options.deliveryIntervalMs ?? 1_000;
  const timer =
    interval > 0
      ? setInterval(() => {
          void drainWebhooks();
        }, interval)
      : null;
  if (timer !== null) timer.unref();

  return {
    runtime,
    adminToken,
    metrics,
    routes: withTrailingSlashAliases(routes),
    defaultSandbox,
    drainWebhooks,
    stop: () => {
      if (timer !== null) clearInterval(timer);
    },
  };
}

/**
 * The official SDK posts to `/checkout/preferences/` with a trailing slash, which the real
 * API accepts and Bun's router treats as a different path. Alias every pattern.
 */
function withTrailingSlashAliases(routes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...routes };
  for (const [pattern, handler] of Object.entries(routes)) {
    if (pattern.endsWith('/') || pattern.includes('*')) continue;
    const alias = `${pattern}/`;
    if (out[alias] === undefined) out[alias] = handler;
  }
  return out;
}

async function json(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
