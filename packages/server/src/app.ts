import { type Clock, type IdGenerator, type RandomSource, type Sandbox, sandboxId } from '@payground/core';
import { createCardToken, getCardToken } from '@payground/mercadopago/api/card-tokens.ts';
import {
  addTransaction,
  cancelOrder,
  captureOrder,
  createOrder,
  deleteTransaction,
  getOrder,
  processOrder,
  refundOrder,
  searchOrders,
  updateTransaction,
} from '@payground/mercadopago/api/orders.ts';
import { getMerchantOrder, searchMerchantOrders } from '@payground/mercadopago/api/merchant-orders.ts';
import { listPaymentMethods } from '@payground/mercadopago/api/payment-methods.ts';
import {
  createPreference,
  getPreference,
  searchPreferences,
  updatePreference,
} from '@payground/mercadopago/api/preferences.ts';
import { checkoutPage, checkoutSubmit } from '@payground/mercadopago/checkout/page.ts';
import {
  createPlan,
  createSubscription,
  getAuthorizedPayment,
  getPlan,
  getSubscription,
  searchAuthorizedPayments,
  searchPlans,
  searchSubscriptions,
  updatePlan,
  updateSubscription,
} from '@payground/mercadopago/api/subscriptions.ts';
import {
  createPayment,
  createRefund,
  getPayment,
  listRefunds,
  searchPayments,
  updatePayment,
} from '@payground/mercadopago/api/payments.ts';
import type { EventSink } from '@payground/mercadopago/api/context.ts';
import { Storage } from '@payground/storage';
import { dashboardHandler } from './dashboard.ts';
import { health } from './health.ts';
import * as control from './control/api.ts';
import { type AppRuntime, contextFor, endpoint, fromResult } from './http/handler.ts';
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
  /** Directory holding the prebuilt dashboard. Omitted means the dashboard is not served. */
  dashboardRoot?: string;
  /** Creates a ready-to-use sandbox on start. Pass false for a bare instance. */
  bootstrap?: BootstrapSandbox | false;
}

export interface App {
  runtime: AppRuntime;
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
  const runtime: AppRuntime = {
    storage,
    clock,
    ids,
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:8080',
    random,
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

  /** The hosted checkout page stands in for the Mercado Pago redirect flow. */
  async function checkout(request: Request, preferenceId: string): Promise<Response> {
    const sandbox = storage.sandboxes.list()[0];
    if (sandbox === undefined) return new Response('no sandbox', { status: 404 });
    const service = contextFor(runtime, sandbox);

    if (request.method === 'GET') {
      const rendered = checkoutPage(service, preferenceId);
      return rendered.ok
        ? new Response(rendered.value.html, {
            status: rendered.value.status,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        : Response.json(rendered.error, { status: rendered.error.status });
    }

    const form = new URLSearchParams(await request.text());
    const submitted = checkoutSubmit(service, preferenceId, form);
    if (!submitted.ok) return Response.json(submitted.error, { status: submitted.error.status });
    if (submitted.value.redirect !== null) {
      return Response.redirect(submitted.value.redirect, 303);
    }
    return new Response(submitted.value.html, {
      status: submitted.value.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const routes = {
    '/_payground/health': () => Response.json(health(clock, startedAt)),
    ...(options.dashboardRoot === undefined
      ? {}
      : {
          '/_payground': dashboardHandler(options.dashboardRoot),
          '/_payground/assets/*': dashboardHandler(options.dashboardRoot),
        }),

    '/_payground/sandboxes': {
      GET: () => send(control.listSandboxes(deps)),
      POST: async (request: Request) => send(control.createSandbox(deps, await json(request))),
    },
    '/_payground/sandboxes/:id': {
      DELETE: (request: Request) => send(control.deleteSandbox(deps, path(request, 'id'))),
    },
    '/_payground/sandboxes/:id/reset': {
      POST: (request: Request) => send(control.resetSandbox(deps, path(request, 'id'))),
    },
    '/_payground/sandboxes/:id/payments': {
      GET: (request: Request) =>
        send(control.listPayments(deps, path(request, 'id'), new URL(request.url).searchParams)),
    },
    '/_payground/sandboxes/:id/payments/:pid': {
      GET: (request: Request) =>
        send(control.getPaymentDetail(deps, path(request, 'id'), path(request, 'pid'))),
    },
    '/_payground/sandboxes/:id/payments/:pid/actions': {
      POST: async (request: Request) =>
        send(control.actOnPayment(deps, path(request, 'id'), path(request, 'pid'), await json(request))),
    },
    '/_payground/sandboxes/:id/webhooks': {
      GET: (request: Request) => send(control.listWebhooks(deps, path(request, 'id'))),
    },
    '/_payground/sandboxes/:id/webhooks/:wid/replay': {
      POST: async (request: Request) => {
        const result = control.replayWebhook(deps, path(request, 'id'), path(request, 'wid'));
        if (result.status === 200) await drainWebhooks();
        return send(result);
      },
    },
    '/_payground/sandboxes/:id/faults': {
      GET: (request: Request) => send(control.getFaults(deps, path(request, 'id'))),
      PUT: async (request: Request) => send(control.setFaults(deps, path(request, 'id'), await json(request))),
    },

    '/checkout/preferences': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createPreference(service, body))),
    },
    '/checkout/preferences/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchPreferences(service, url.searchParams))),
    },
    '/checkout/preferences/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getPreference(service, param(request, 'id')))),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updatePreference(service, param(request, 'id'), body)),
      ),
    },
    '/merchant_orders/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchMerchantOrders(service, url.searchParams))),
    },
    '/merchant_orders/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getMerchantOrder(service, param(request, 'id')))),
    },

    '/checkout/:id': {
      GET: (request: Request) => checkout(request, param(request, 'id')),
      POST: (request: Request) => checkout(request, param(request, 'id')),
    },

    '/v1/orders': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createOrder(service, body)), {
        idempotency: 'required',
      }),
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchOrders(service, url.searchParams))),
    },
    '/v1/orders/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getOrder(service, param(request, 'id')))),
    },
    '/v1/orders/:id/process': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(processOrder(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/capture': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(captureOrder(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/cancel': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(cancelOrder(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/refund': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(refundOrder(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/transactions': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(addTransaction(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/transactions/:tid': {
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updateTransaction(service, param(request, 'id'), param(request, 'tid'), body)),
      ),
      DELETE: endpoint(runtime, ({ service, request }) =>
        fromResult(deleteTransaction(service, param(request, 'id'), param(request, 'tid'))),
      ),
    },

    '/preapproval_plan': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createPlan(service, body))),
    },
    '/preapproval_plan/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchPlans(service, url.searchParams))),
    },
    '/preapproval_plan/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getPlan(service, param(request, 'id')))),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updatePlan(service, param(request, 'id'), body)),
      ),
    },
    '/preapproval': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createSubscription(service, body))),
    },
    '/preapproval/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchSubscriptions(service, url.searchParams))),
    },
    '/preapproval/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getSubscription(service, param(request, 'id')))),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updateSubscription(service, param(request, 'id'), body)),
      ),
    },
    '/authorized_payments': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchAuthorizedPayments(service, url.searchParams))),
    },
    '/authorized_payments/:id': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getAuthorizedPayment(service, param(request, 'id'))),
      ),
    },

    '/v1/card_tokens': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createCardToken(service, body)), {
        accepts: ['access_token', 'public_key'],
      }),
    },
    '/v1/card_tokens/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getCardToken(service, param(request, 'id'))), {
        accepts: ['access_token', 'public_key'],
      }),
    },
    '/v1/payment_methods': {
      GET: endpoint(runtime, ({ service }) => fromResult(listPaymentMethods(service)), {
        accepts: ['access_token', 'public_key'],
      }),
    },

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
    routes,
    defaultSandbox,
    drainWebhooks,
    stop: () => {
      if (timer !== null) clearInterval(timer);
    },
  };
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
