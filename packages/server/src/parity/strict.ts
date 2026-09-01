import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApiRequestEntry, ApiRequestLog, ApiRequestQuery, Sandbox } from '@payground/core';
import { badRequest, errorResponse } from '@payground/mercadopago/errors.ts';
import { authenticate } from '../http/auth.ts';
import { type AppRuntime, normaliseRoute } from '../http/handler.ts';
import { ConformanceRecorder, attachRecorder } from './recorder.ts';
import { operationFor, responseSchema } from './spec.ts';
import { validateNamed, validateSchema } from './validate.ts';

type Handler = (request: Request) => Response | Promise<Response>;

const bodies = new AsyncLocalStorage<{ body: string | null }>();

/** Card data never reaches the history: `payground doctor` only needs the shape. */
const SENSITIVE = new Set(['card_number', 'security_code', 'cvv']);

function redact(body: string | null): string | null {
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  let changed = false;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => {
        if (!SENSITIVE.has(key) || typeof child !== 'string') return [key, walk(child)];
        changed = true;
        return [key, '***'];
      }),
    );
  };
  const clean = walk(parsed);
  return changed ? JSON.stringify(clean) : body;
}

/**
 * The request history is written from inside `endpoint()`, which never sees the raw body,
 * so the body reaches it through the async context of the call instead.
 */
function capturing(log: ApiRequestLog): ApiRequestLog {
  return {
    record: (entry: ApiRequestEntry) =>
      log.record({ ...entry, requestBody: redact(entry.requestBody ?? bodies.getStore()?.body ?? null) }),
    get: (id: string) => log.get(id),
    search: (query: ApiRequestQuery) => log.search(query),
    purgeBefore: (cutoff: number) => log.purgeBefore(cutoff),
  };
}

export interface InstrumentOptions {
  runtime: AppRuntime;
  routes: Record<string, unknown>;
  /** Validate requests against the spec and refuse what the real API would refuse. */
  strict: boolean;
}

export function instrument(options: InstrumentOptions): Record<string, unknown> {
  const { runtime, strict } = options;
  runtime.requests = capturing(runtime.requests);
  const recorder = new ConformanceRecorder();
  attachRecorder(runtime, recorder);

  const wrap =
    (handler: Handler): Handler =>
    async (request) => {
      const url = new URL(request.url);
      const carriesBody = request.method !== 'GET' && request.method !== 'DELETE';
      const raw = carriesBody && (strict || runtime.historyBodyLimit > 0) ? await request.clone().text() : '';
      const route = operationFor(request.method, url.pathname);

      if (strict && carriesBody && route?.requestSchema !== undefined) {
        const rejected = refuse(runtime, request, url, route.requestSchema, raw);
        if (rejected !== null) return await observe(runtime, request, url, raw, rejected);
      }

      const response =
        raw === ''
          ? await handler(request)
          : await bodies.run({ body: cap(raw, runtime.historyBodyLimit) }, () => handler(request));

      if (strict && route !== undefined && response.status < 300) {
        const schema = responseSchema(route.operationId, response.status);
        const body = schema === undefined ? undefined : safeParse(await response.clone().text());
        if (schema !== undefined && body !== undefined) {
          recorder.record(route.operationId, response.status, validateSchema(schema, body));
        }
      }
      return response;
    };

  const wrapped: Record<string, unknown> = {};
  for (const [pattern, value] of Object.entries(options.routes)) {
    if (pattern.startsWith('/_payground')) {
      wrapped[pattern] = value;
    } else if (typeof value === 'function') {
      wrapped[pattern] = wrap(value as Handler);
    } else if (isMethodMap(value)) {
      wrapped[pattern] = Object.fromEntries(
        Object.entries(value).map(([method, handler]) => [method, wrap(handler as Handler)]),
      );
    } else {
      wrapped[pattern] = value;
    }
  }
  return wrapped;
}

interface Rejection {
  response: Response;
  sandbox: Sandbox;
}

/**
 * Credentials are checked first, so strict mode never turns a 401 into a 400, and an
 * injected outage still wins. Everything else `endpoint()` does, the rate limiter, the
 * fault latency and error rate, an idempotent replay, happens after this check, because
 * validation has to run before the handler can act on the body.
 */
function refuse(runtime: AppRuntime, request: Request, url: URL, schema: string, raw: string): Rejection | null {
  const principal = authenticate(runtime.storage.sandboxes, request, url, ['access_token', 'public_key']);
  if (!principal.ok) return null;
  if (runtime.storage.forSandbox(principal.value.sandbox.id).faults.get().unavailable) return null;

  const body = raw === '' ? {} : safeParse(raw);
  if (body === undefined) return null;
  const issues = validateNamed(schema, body);
  if (issues.length === 0) return null;

  return {
    sandbox: principal.value.sandbox,
    response: errorResponse(
      badRequest(
        'the request body does not match the OpenAPI specification',
        issues.map((issue) => ({ code: 'strict_mode', description: `${issue.path}: ${issue.message}` })),
      ),
    ),
  };
}

/** A refusal never reaches `endpoint()`, so it is metered and recorded here instead. */
async function observe(
  runtime: AppRuntime,
  request: Request,
  url: URL,
  raw: string,
  rejected: Rejection,
): Promise<Response> {
  const route = normaliseRoute(url.pathname);
  const labels = { route, method: request.method, status: '400', sandbox: rejected.sandbox.id };
  runtime.metrics.count('payground_api_requests_total', labels);
  runtime.metrics.observe('payground_api_request_duration_ms', labels, 0);
  runtime.requests.record({
    id: runtime.ids.uuid(),
    at: runtime.clock.now(),
    sandbox: rejected.sandbox.id,
    method: request.method,
    route,
    path: url.pathname,
    status: 400,
    durationMs: 0,
    requestBody: cap(raw, runtime.historyBodyLimit),
    responseBody: cap(await rejected.response.clone().text(), runtime.historyBodyLimit),
    idempotencyKey: request.headers.get('x-idempotency-key'),
    userAgent: request.headers.get('user-agent'),
  });
  return rejected.response;
}

const isMethodMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).length > 0 &&
  Object.values(value).every((entry) => typeof entry === 'function');

const cap = (body: string, limit: number): string | null => (limit > 0 && body.length <= limit ? body : null);

function safeParse(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
