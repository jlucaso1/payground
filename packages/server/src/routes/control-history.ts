import type {
  ApiRequestEntry,
  ApiRequestQuery,
  AuditEntry,
  AuditQuery,
  JsonValue,
  Page,
  SandboxId,
} from '@payground/core';
import { sandboxId } from '@payground/core';
import type { AppRuntime } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

const REDACTED = '[redacted]';

const SECRET_KEY = /^(number|card_number|security_code|cvv|cvc|password)$|(^|_)(secret|token)$/i;

/** Runs of digits that may hold a card number, allowing the usual space and dash grouping. */
const DIGIT_RUN = /\d[\d -]*\d/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

const isPan = (digits: string): boolean => digits.length >= 13 && digits.length <= 19 && luhn(digits);

/**
 * A card number is either one group of digits or consecutive groups split by the usual
 * separators, so only those combinations are tested. Scanning inside a single long group
 * would flag boleto barcodes and digitable lines, which are what history is opened for.
 */
function scrubRun(run: string): string {
  const groups = run.split(/[ -]+/).filter((group) => group !== '');
  for (let start = 0; start < groups.length; start++) {
    let digits = '';
    for (let end = start; end < groups.length; end++) {
      digits += groups[end] ?? '';
      if (digits.length > 19) break;
      if (isPan(digits)) return REDACTED;
    }
  }
  return run;
}

const scrubText = (raw: string): string => raw.replace(DIGIT_RUN, scrubRun);

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return scrubText(value);
  // Numbers are left alone: epoch milliseconds and long ids pass Luhn far too often.
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(nested);
    }
    return out;
  }
  return value;
}

/** Stored bodies are opaque text: redact them as JSON when possible, as text otherwise. */
export function redactBody(body: string | null): string | null {
  if (body === null) return null;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body) as JsonValue;
  } catch {
    return scrubText(body);
  }
  return JSON.stringify(redactValue(parsed));
}

const summary = (entry: ApiRequestEntry) => ({
  id: entry.id,
  at: entry.at,
  sandbox: entry.sandbox,
  method: entry.method,
  route: entry.route,
  path: entry.path,
  status: entry.status,
  durationMs: entry.durationMs,
  idempotencyKey: entry.idempotencyKey,
  userAgent: entry.userAgent,
});

const detail = (entry: ApiRequestEntry) => ({
  ...summary(entry),
  requestBody: redactBody(entry.requestBody),
  responseBody: redactBody(entry.responseBody),
});

const page = <T, R>(source: Page<T>, view: (item: T) => R) => ({
  total: source.total,
  limit: source.limit,
  offset: source.offset,
  results: source.results.map(view),
});

const auditView = (entry: AuditEntry) => ({
  id: entry.id,
  at: entry.at,
  actor: entry.actor,
  action: entry.action,
  target: entry.target,
  sandbox: entry.sandbox,
  detail: entry.detail,
});

/** An empty filter means "no filter", not "match the empty string". */
function text(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name);
  return raw === null || raw.trim() === '' ? undefined : raw;
}

/** Every numeric filter is a count, a status or an epoch, so a fraction is not a value. */
function number(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function paging(params: URLSearchParams): { limit?: number; offset?: number } {
  const limit = number(params, 'limit');
  const offset = number(params, 'offset');
  return { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) };
}

function requestQuery(params: URLSearchParams, sandbox: SandboxId | undefined): ApiRequestQuery {
  const scope = sandbox ?? text(params, 'sandbox');
  const route = text(params, 'route');
  const method = text(params, 'method');
  const status = number(params, 'status');
  const minStatus = number(params, 'min_status');
  const from = number(params, 'from');
  const to = number(params, 'to');
  return {
    ...(scope === undefined ? {} : { sandbox: sandboxId(scope) }),
    ...(route === undefined ? {} : { route }),
    ...(method === undefined ? {} : { method: method.toUpperCase() }),
    ...(status === undefined ? {} : { status }),
    ...(minStatus === undefined ? {} : { minStatus }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...paging(params),
  };
}

function auditQuery(params: URLSearchParams, sandbox: SandboxId | undefined): AuditQuery {
  const scope = sandbox ?? text(params, 'sandbox');
  const action = text(params, 'action');
  const from = number(params, 'from');
  const to = number(params, 'to');
  return {
    ...(scope === undefined ? {} : { sandbox: sandboxId(scope) }),
    ...(action === undefined ? {} : { action }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...paging(params),
  };
}

function purge(
  runtime: AppRuntime,
  what: 'requests' | 'audit',
  params: URLSearchParams,
  run: (cutoff: number) => number,
): Response {
  const before = number(params, 'before');
  if (before === undefined) return Response.json({ error: 'before is required' }, { status: 400 });
  const deleted = run(before);
  // Recorded after the purge so erasing the trail is itself on the trail.
  runtime.audit.record({
    id: runtime.ids.uuid(),
    at: runtime.clock.now(),
    actor: { kind: 'admin' },
    action: `${what}.purged`,
    target: what,
    sandbox: null,
    detail: { before, deleted },
  });
  return Response.json({ deleted });
}

/** Request history and audit trail for the control API. Control routes serve no spec operation, so both lists stay empty. */
export const controlHistory: RouteModule = {
  name: 'control-history',
  operations: [],
  pending: [],
  routes: ({ runtime, admin, param }) => {
    const params = (request: Request) => new URL(request.url).searchParams;
    const scoped = (request: Request) => sandboxId(param(request, 'id'));

    return {
      '/_payground/requests': {
        GET: admin((request) =>
          Response.json(page(runtime.requests.search(requestQuery(params(request), undefined)), summary)),
        ),
        DELETE: admin((request) =>
          purge(runtime, 'requests', params(request), (cutoff) => runtime.requests.purgeBefore(cutoff)),
        ),
      },
      '/_payground/requests/:id': {
        GET: admin((request) => {
          const entry = runtime.requests.get(param(request, 'id'));
          return entry === null
            ? Response.json({ error: 'request not found' }, { status: 404 })
            : Response.json(detail(entry));
        }),
      },
      '/_payground/audit': {
        GET: admin((request) =>
          Response.json(page(runtime.audit.search(auditQuery(params(request), undefined)), auditView)),
        ),
        DELETE: admin((request) =>
          purge(runtime, 'audit', params(request), (cutoff) => runtime.audit.purgeBefore(cutoff)),
        ),
      },
      '/_payground/sandboxes/:id/requests': {
        GET: admin((request) =>
          Response.json(page(runtime.requests.search(requestQuery(params(request), scoped(request))), summary)),
        ),
      },
      '/_payground/sandboxes/:id/audit': {
        GET: admin((request) =>
          Response.json(page(runtime.audit.search(auditQuery(params(request), scoped(request))), auditView)),
        ),
      },
    };
  },
};
