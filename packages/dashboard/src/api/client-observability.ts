import { API_PREFIX, type ApiClientOptions, type ApiError, type ApiResult, type FetchLike } from './client.ts';
import type {
  ApiRequestEntry,
  AuditEntry,
  AuditLogQuery,
  MetricsView,
  Page,
  RequestLogQuery,
} from './types.ts';

function toQuery(entries: readonly (readonly [string, string | number | undefined])[]): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    const text = String(value);
    if (text === '') continue;
    params.set(key, text);
  }
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

export function buildRequestQuery(query: RequestLogQuery): string {
  return toQuery([
    ['sandbox', query.sandbox],
    ['route', query.route],
    ['method', query.method],
    ['status', query.status],
    ['min_status', query.min_status],
    ['from', query.from],
    ['to', query.to],
    ['limit', query.limit],
    ['offset', query.offset],
  ]);
}

export function buildAuditQuery(query: AuditLogQuery): string {
  return toQuery([
    ['sandbox', query.sandbox],
    ['action', query.action],
    ['from', query.from],
    ['to', query.to],
    ['limit', query.limit],
    ['offset', query.offset],
  ]);
}

/** The observability endpoints ship in a later release; 404 means "this instance has none". */
export function isUnavailable(error: ApiError): boolean {
  return error.kind === 'http' && error.status === 404;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface ObservabilityClient {
  getMetrics(sandboxId: string | null): Promise<ApiResult<MetricsView>>;
  listRequests(query: RequestLogQuery): Promise<ApiResult<Page<ApiRequestEntry>>>;
  getRequest(id: string): Promise<ApiResult<ApiRequestEntry>>;
  listAudit(query: AuditLogQuery): Promise<ApiResult<Page<AuditEntry>>>;
}

export function createObservabilityClient(options: ApiClientOptions = {}): ObservabilityClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const token = options.token ?? (() => null);

  async function request<T>(path: string): Promise<ApiResult<T>> {
    const url = `${baseUrl}${API_PREFIX}${path}`;
    let response: Response;
    try {
      const admin = token();
      const headers: Record<string, string> = { accept: 'application/json' };
      if (admin !== null && admin !== '') headers['authorization'] = `Bearer ${admin}`;
      response = await doFetch(url, { method: 'GET', headers });
    } catch (cause) {
      return { ok: false, error: { kind: 'network', message: errorMessage(cause), status: null } };
    }

    const text = await response.text().catch(() => '');

    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind: response.status === 401 ? 'unauthorized' : 'http',
          message: text === '' ? `HTTP ${response.status}` : text,
          status: response.status,
        },
      };
    }

    try {
      return { ok: true, value: JSON.parse(text) as T };
    } catch (cause) {
      return {
        ok: false,
        error: { kind: 'parse', message: errorMessage(cause), status: response.status },
      };
    }
  }

  const enc = encodeURIComponent;

  return {
    getMetrics: (sandboxId) =>
      request<MetricsView>(
        sandboxId === null
          ? '/metrics?format=json'
          : `/sandboxes/${enc(sandboxId)}/metrics?format=json`,
      ),
    listRequests: (query) => request<Page<ApiRequestEntry>>(`/requests${buildRequestQuery(query)}`),
    getRequest: (id) => request<ApiRequestEntry>(`/requests/${enc(id)}`),
    listAudit: (query) => request<Page<AuditEntry>>(`/audit${buildAuditQuery(query)}`),
  };
}
