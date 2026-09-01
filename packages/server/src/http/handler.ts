import type {
  ApiRequestLog,
  AuditLog,
  Clock,
  IdGenerator,
  MetricsSink,
  RandomSource,
  RateLimiter,
  Sandbox,
  SandboxRegistry,
} from '@payground/core';
import type { ServiceContext } from '@payground/mercadopago/api/context.ts';
import type { EventSink } from '@payground/mercadopago/api/context.ts';
import { enqueue } from '../webhook/enqueue.ts';
import { type ErrorBody, errorResponse, serverError, tooManyRequests } from '@payground/mercadopago/errors.ts';
import type { Storage } from '@payground/storage';
import { type CredentialKind, authenticate } from './auth.ts';
import { check, fingerprint, remember } from './idempotency.ts';

export interface AppRuntime {
  storage: Storage;
  clock: Clock;
  ids: IdGenerator;
  baseUrl: string;
  random: RandomSource;
  metrics: MetricsSink;
  requests: ApiRequestLog;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  /** Bodies larger than this are not kept in the request history. */
  historyBodyLimit: number;
  /** Set for tests that want to observe notices instead of queueing deliveries. */
  events?: EventSink;
}

export interface RequestScope {
  service: ServiceContext;
  url: URL;
  request: Request;
  body: unknown;
  rawBody: string;
}

export type Endpoint = (scope: RequestScope) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

export interface EndpointOptions {
  /** Spec path, used as the metrics and history label so ids do not explode cardinality. */
  route?: string;
  accepts?: readonly CredentialKind[];
  /** Mercado Pago requires X-Idempotency-Key on payment creation. */
  idempotency?: 'required' | 'optional' | 'off';
}

const COLLECTOR_BASE = 100_000_000;

const collectorId = (sandboxId: string): number => {
  const hash = new Bun.CryptoHasher('sha256').update(sandboxId).digest('hex').slice(0, 8);
  return COLLECTOR_BASE + Number.parseInt(hash, 16) % 900_000_000;
};

/** Emitting a notice queues a signed delivery; nothing is sent inline. */
export function contextFor(runtime: AppRuntime, sandbox: Sandbox): ServiceContext {
  const store = runtime.storage.forSandbox(sandbox.id);
  const collector = collectorId(sandbox.id);
  const events: EventSink = runtime.events ?? {
    emit: (notice) => {
      enqueue({
        store,
        sandbox,
        ids: runtime.ids,
        notice,
        now: runtime.clock.now(),
        collectorId: collector,
      });
    },
  };
  return {
    store,
    sandbox,
    clock: runtime.clock,
    ids: runtime.ids,
    baseUrl: runtime.baseUrl,
    collectorId: collector,
    events,
  };
}

export function serviceFor(runtime: AppRuntime, registry: SandboxRegistry, id: string): ServiceContext | null {
  const sandbox = registry.get(id as never);
  return sandbox === null ? null : contextFor(runtime, sandbox);
}

const NUMERIC = /^\d+$/;
/** Any long segment carrying a digit is an id: uuids, sequences, and the two combined. */
const IDENTIFIER = /^(?=.*\d)[0-9a-zA-Z_.-]{8,}$/;

/** Keeps metric and history labels bounded: /v1/payments/123 becomes /v1/payments/:id. */
export function normaliseRoute(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (NUMERIC.test(segment) || IDENTIFIER.test(segment) ? ':id' : segment))
    .join('/');
}

export function endpoint(runtime: AppRuntime, handler: Endpoint, options: EndpointOptions = {}) {
  const accepts = options.accepts ?? ['access_token'];
  const mode = options.idempotency ?? 'off';

  const run = async (
    request: Request,
    url: URL,
    observed: { sandbox: Sandbox | null },
  ): Promise<Response> => {
    const principal = authenticate(runtime.storage.sandboxes, request, url, accepts);
    if (!principal.ok) return errorResponse(principal.error);
    observed.sandbox = principal.value.sandbox;

    const limit = runtime.rateLimiter.take(principal.value.sandbox.id, runtime.clock.now());
    if (!limit.allowed) {
      return new Response(JSON.stringify(tooManyRequests()), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)),
        },
      });
    }

    const rawBody = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    let body: unknown = undefined;
    if (rawBody !== '') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return errorResponse({
          message: 'the body must be a Json Object',
          error: 'bad_request',
          status: 400,
          cause: [{ code: 118, description: 'the body must be a Json Object' }],
        });
      }
    }

    const service = contextFor(runtime, principal.value.sandbox);

    const faults = service.store.faults.get();
    if (faults.unavailable) {
      return errorResponse({
        message: 'service unavailable',
        error: 'service_unavailable',
        status: 503,
        cause: [{ code: 5001, description: 'injected outage' }],
      });
    }
    if (faults.errorRate > 0 && runtime.random.int(10_000) < faults.errorRate * 10_000) {
      return errorResponse(serverError('injected failure'));
    }
    if (faults.latencyMs > 0) await Bun.sleep(faults.latencyMs);

    const key = request.headers.get('x-idempotency-key');
    const print = fingerprint(request.method, url.pathname, rawBody);
    const now = runtime.clock.now();

    if (mode !== 'off') {
      const outcome = check(service.store.idempotency, key, print, now, mode === 'required');
      if (outcome.kind === 'error') return errorResponse(outcome.error);
      if (outcome.kind === 'replay') {
        return new Response(outcome.replay.body, {
          status: outcome.replay.status,
          headers: { 'content-type': 'application/json', 'x-idempotency-replayed': 'true' },
        });
      }
    }

    let result: { status: number; body: unknown };
    try {
      result = await handler({ service, url, request, body, rawBody });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(serverError(message));
    }

    const serialized = JSON.stringify(result.body);
    if (mode !== 'off') remember(service.store.idempotency, key, print, now, result.status, serialized);

    return new Response(serialized, {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = options.route ?? normaliseRoute(url.pathname);
    const started = runtime.clock.now();
    const observed: { sandbox: Sandbox | null } = { sandbox: null };

    const response = await run(request, url, observed);
    const durationMs = Math.max(runtime.clock.now() - started, 0);
    const labels = {
      route,
      method: request.method,
      status: String(response.status),
      sandbox: observed.sandbox?.id ?? 'anonymous',
    };
    runtime.metrics.count('payground_api_requests_total', labels);
    runtime.metrics.observe('payground_api_request_duration_ms', labels, durationMs);

    // Cloning keeps the caller's response untouched while the history keeps a copy.
    const responseBody = runtime.historyBodyLimit > 0 ? await response.clone().text() : '';
    runtime.requests.record({
      id: runtime.ids.uuid(),
      at: started,
      sandbox: observed.sandbox?.id ?? null,
      method: request.method,
      route,
      path: url.pathname,
      status: response.status,
      durationMs,
      requestBody: null,
      responseBody: responseBody === '' || responseBody.length > runtime.historyBodyLimit ? null : responseBody,
      idempotencyKey: request.headers.get('x-idempotency-key'),
      userAgent: request.headers.get('user-agent'),
    });

    return response;
  };
}

export const fromResult = (
  result: { ok: true; value: { status: number; body: unknown } } | { ok: false; error: ErrorBody },
): { status: number; body: unknown } =>
  result.ok ? result.value : { status: result.error.status, body: result.error };
