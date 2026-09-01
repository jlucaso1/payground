import type { ApiRequestEntry, ApiRequestLog } from '@payground/core';
import { DIVERGENCES } from '../../../../spec/overlay.ts';
import { MODULES } from '../routes/index.ts';
import { operationFor, responseSchema } from './spec.ts';
import { type Finding, collapseIndices, validateNamed, validateSchema } from './validate.ts';

export interface OperationUsage {
  operationId: string;
  module: string;
  state: 'emulated' | 'pending';
  calls: number;
  reason?: string;
}

export interface RouteUsage {
  method: string;
  route: string;
  calls: number;
}

export interface RejectedRequest {
  operationId: string;
  method: string;
  route: string;
  schema: string;
  calls: number;
  issues: Finding[];
}

export interface ResponseDrift {
  operationId: string;
  status: number;
  calls: number;
  issues: Finding[];
}

export interface ReportedDivergence {
  area: string;
  summary: string;
  detail: string;
  source: string;
}

export interface ParityReport {
  generatedAt: number;
  sandbox: string | null;
  requests: number;
  operations: OperationUsage[];
  undocumented: RouteUsage[];
  rejected: RejectedRequest[];
  responseDrift: ResponseDrift[];
  divergences: ReportedDivergence[];
  verdict: { blocking: boolean; findings: string[] };
}

export interface ReportInput {
  entries: readonly ApiRequestEntry[];
  now: number;
  sandbox?: string | null;
  /** Response divergences observed live by strict mode, merged with the stored ones. */
  drift?: readonly ResponseDrift[];
}

interface Registered {
  module: string;
  state: 'emulated' | 'pending';
  reason?: string;
}

let registry: Map<string, Registered> | null = null;

/** Built lazily: the route registry imports this module through the parity control route. */
function registered(): Map<string, Registered> {
  if (registry !== null) return registry;
  const index = new Map<string, Registered>();
  for (const module of MODULES) {
    for (const operationId of module.operations) index.set(operationId, { module: module.name, state: 'emulated' });
    for (const item of module.pending) {
      index.set(item.operationId, { module: module.name, state: 'pending', reason: item.reason });
    }
  }
  registry = index;
  return index;
}

const HISTORY_PAGE = 1000;

const countCalls = (count: number): string => `${count} call${count === 1 ? '' : 's'}`;

/**
 * Reads the whole history, oldest first. `to` pins the window, so a call recorded while
 * the report is being built cannot shift the pages and be counted twice.
 */
export function readHistory(log: ApiRequestLog, sandbox: string | null, to: number): ApiRequestEntry[] {
  const entries: ApiRequestEntry[] = [];
  for (let offset = 0; ; offset += HISTORY_PAGE) {
    const page = log.search({
      limit: HISTORY_PAGE,
      offset,
      to,
      ...(sandbox === null ? {} : { sandbox: sandbox as never }),
    });
    entries.push(...page.results);
    if (entries.length >= page.total || page.results.length === 0) break;
  }
  return entries.reverse();
}

const parse = (raw: string | null): { ok: boolean; value: unknown } => {
  if (raw === null || raw === '') return { ok: false, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: undefined };
  }
};

const mergeIssues = (into: Finding[], issues: readonly Finding[]): void => {
  for (const issue of issues) {
    if (!into.some((kept) => kept.path === issue.path && kept.message === issue.message)) into.push(issue);
  }
};

interface Usage {
  operations: Set<string>;
  routes: Set<string>;
  statuses: Set<number>;
  methods: Set<string>;
  agents: string[];
  bodies: string[];
}

/** Which recorded divergences an integrator is exposed to, given what they called. */
const RELEVANT: Record<string, (usage: Usage) => boolean> = {
  Payments: (usage) => [...usage.routes].some((route) => route.includes('/v1/payments')),
  Webhooks: (usage) => ['POST', 'PUT', 'DELETE'].some((method) => usage.methods.has(method)),
  Errors: (usage) => [...usage.statuses].some((status) => status >= 400),
  Pix: (usage) => usage.bodies.some((body) => body.includes('"pix"') || body.includes('point_of_interaction')),
  'Merchant orders': (usage) => [...usage.routes].some((route) => route.startsWith('/merchant_orders')),
  'Node SDK': (usage) => usage.agents.some((agent) => /mercadopago/i.test(agent)),
  Fixtures: () => false,
};

export function buildReport(input: ReportInput): ParityReport {
  const index = registered();
  const usage: Usage = {
    operations: new Set(),
    routes: new Set(),
    statuses: new Set(),
    methods: new Set(),
    agents: [],
    bodies: [],
  };
  const calls = new Map<string, number>();
  const undocumented = new Map<string, RouteUsage>();
  const rejected = new Map<string, RejectedRequest>();
  const drift = new Map<string, ResponseDrift>();
  let requests = 0;

  for (const entry of input.entries) {
    if (entry.route.startsWith('/_payground')) continue;
    requests += 1;
    usage.routes.add(entry.route);
    usage.methods.add(entry.method);
    usage.statuses.add(entry.status);
    if (entry.userAgent !== null) usage.agents.push(entry.userAgent);
    if (entry.requestBody !== null) usage.bodies.push(entry.requestBody);
    if (entry.responseBody !== null) usage.bodies.push(entry.responseBody);

    const route = operationFor(entry.method, entry.route);
    if (route === undefined) {
      const key = `${entry.method} ${entry.route}`;
      const seen = undocumented.get(key);
      if (seen === undefined) undocumented.set(key, { method: entry.method, route: entry.route, calls: 1 });
      else seen.calls += 1;
      continue;
    }

    usage.operations.add(route.operationId);
    calls.set(route.operationId, (calls.get(route.operationId) ?? 0) + 1);

    const schema = route.requestSchema;
    const body = parse(entry.requestBody);
    if (schema !== undefined && body.ok) {
      const issues = validateNamed(schema, body.value);
      if (issues.length > 0) {
        const key = `${entry.method} ${entry.route}`;
        const seen = rejected.get(key);
        if (seen === undefined) {
          rejected.set(key, {
            operationId: route.operationId,
            method: entry.method,
            route: entry.route,
            schema,
            calls: 1,
            issues: [...issues],
          });
        } else {
          seen.calls += 1;
          mergeIssues(seen.issues, issues);
        }
      }
    }

    const response = parse(entry.responseBody);
    const expected = entry.status < 300 ? responseSchema(route.operationId, entry.status) : undefined;
    if (expected !== undefined && response.ok) {
      const issues = validateSchema(expected, response.value);
      if (issues.length > 0) record(drift, route.operationId, entry.status, collapseIndices(issues));
    }
  }

  // A live observation and the stored response body of the same call describe one call,
  // so strict mode's records raise the count instead of adding to it.
  for (const observed of input.drift ?? []) {
    record(drift, observed.operationId, observed.status, observed.issues, observed.calls, 'atLeast');
  }

  const operations: OperationUsage[] = [...calls.entries()]
    .map(([operationId, count]) => {
      const known = index.get(operationId) ?? { module: 'unknown', state: 'pending' as const, reason: 'not registered in any module' };
      return {
        operationId,
        module: known.module,
        state: known.state,
        calls: count,
        ...(known.reason === undefined ? {} : { reason: known.reason }),
      };
    })
    .sort((a, b) => b.calls - a.calls || a.operationId.localeCompare(b.operationId));

  const divergences = DIVERGENCES.filter((entry) => (RELEVANT[entry.area] ?? (() => true))(usage)).map((entry) => ({
    area: entry.area,
    summary: entry.summary,
    detail: entry.detail,
    source: entry.source,
  }));

  const pending = operations.filter((operation) => operation.state === 'pending');
  const rejections = [...rejected.values()].sort((a, b) => b.calls - a.calls);
  const findings: string[] = [];
  for (const operation of pending) {
    findings.push(
      `${operation.operationId} is not emulated (${operation.reason ?? 'pending'}); payground answered ${countCalls(operation.calls)} with a stub`,
    );
  }
  for (const rejection of rejections) {
    findings.push(
      `${countCalls(rejection.calls)} to ${rejection.method} ${rejection.route} ${rejection.calls === 1 ? 'sends' : 'send'} a body the real API would refuse: ${rejection.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; ')}`,
    );
  }

  return {
    generatedAt: input.now,
    sandbox: input.sandbox ?? null,
    requests,
    operations,
    undocumented: [...undocumented.values()].sort((a, b) => b.calls - a.calls),
    rejected: rejections,
    responseDrift: [...drift.values()].sort((a, b) => b.calls - a.calls),
    divergences,
    verdict: { blocking: findings.length > 0, findings },
  };
}

function record(
  into: Map<string, ResponseDrift>,
  operationId: string,
  status: number,
  issues: readonly Finding[],
  calls = 1,
  mode: 'add' | 'atLeast' = 'add',
): void {
  const key = `${operationId} ${status}`;
  const seen = into.get(key);
  if (seen === undefined) into.set(key, { operationId, status, calls, issues: [...issues] });
  else {
    seen.calls = mode === 'add' ? seen.calls + calls : Math.max(seen.calls, calls);
    mergeIssues(seen.issues, issues);
  }
}
