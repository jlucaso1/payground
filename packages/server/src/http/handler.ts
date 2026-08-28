import type { Clock, IdGenerator, Sandbox, SandboxRegistry } from '@payground/core';
import type { ServiceContext } from '@payground/mercadopago/api/context.ts';
import type { EventSink } from '@payground/mercadopago/api/context.ts';
import { enqueue } from '../webhook/enqueue.ts';
import { type ErrorBody, errorResponse, serverError } from '@payground/mercadopago/errors.ts';
import type { Storage } from '@payground/storage';
import { type CredentialKind, authenticate } from './auth.ts';
import { check, fingerprint, remember } from './idempotency.ts';

export interface AppRuntime {
  storage: Storage;
  clock: Clock;
  ids: IdGenerator;
  baseUrl: string;
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

export function endpoint(runtime: AppRuntime, handler: Endpoint, options: EndpointOptions = {}) {
  const accepts = options.accepts ?? ['access_token'];
  const mode = options.idempotency ?? 'off';

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const principal = authenticate(runtime.storage.sandboxes, request, url, accepts);
    if (!principal.ok) return errorResponse(principal.error);

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
}

export const fromResult = (
  result: { ok: true; value: { status: number; body: unknown } } | { ok: false; error: ErrorBody },
): { status: number; body: unknown } =>
  result.ok ? result.value : { status: result.error.status, body: result.error };
