import type {
  FaultProfile,
  HealthView,
  OkResponse,
  PaymentAction,
  PaymentDetail,
  PaymentPage,
  PaymentQuery,
  PaymentView,
  Sandbox,
  WebhookDeliveryView,
} from './types.ts';

export interface ApiError {
  kind: 'http' | 'network' | 'parse';
  message: string;
  status: number | null;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
}

export const API_PREFIX = '/_payground';

export function buildQuery(query: PaymentQuery): string {
  const params = new URLSearchParams();
  if (query.state !== undefined) params.set('state', query.state);
  if (query.method !== undefined && query.method !== '') params.set('method', query.method);
  if (query.external_reference !== undefined && query.external_reference !== '') {
    params.set('external_reference', query.external_reference);
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export interface ApiClient {
  getHealth(): Promise<ApiResult<HealthView>>;
  listSandboxes(): Promise<ApiResult<Sandbox[]>>;
  createSandbox(name: string): Promise<ApiResult<Sandbox>>;
  resetSandbox(id: string): Promise<ApiResult<OkResponse>>;
  deleteSandbox(id: string): Promise<ApiResult<OkResponse>>;
  listPayments(id: string, query?: PaymentQuery): Promise<ApiResult<PaymentPage>>;
  getPayment(id: string, paymentId: string): Promise<ApiResult<PaymentDetail>>;
  applyAction(
    id: string,
    paymentId: string,
    action: PaymentAction,
  ): Promise<ApiResult<{ payment: PaymentView }>>;
  listWebhooks(id: string): Promise<ApiResult<WebhookDeliveryView[]>>;
  replayWebhook(id: string, webhookId: string): Promise<ApiResult<OkResponse>>;
  getFaults(id: string): Promise<ApiResult<FaultProfile>>;
  setFaults(id: string, profile: FaultProfile): Promise<ApiResult<FaultProfile>>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const url = `${baseUrl}${API_PREFIX}${path}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      return { ok: false, error: { kind: 'network', message: errorMessage(cause), status: null } };
    }

    const text = await response.text().catch(() => '');

    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind: 'http',
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
    getHealth: () => request<HealthView>('GET', '/health'),
    listSandboxes: () => request<Sandbox[]>('GET', '/sandboxes'),
    createSandbox: (name) => request<Sandbox>('POST', '/sandboxes', { name }),
    resetSandbox: (id) => request<OkResponse>('POST', `/sandboxes/${enc(id)}/reset`),
    deleteSandbox: (id) => request<OkResponse>('DELETE', `/sandboxes/${enc(id)}`),
    listPayments: (id, query = {}) =>
      request<PaymentPage>('GET', `/sandboxes/${enc(id)}/payments${buildQuery(query)}`),
    getPayment: (id, paymentId) =>
      request<PaymentDetail>('GET', `/sandboxes/${enc(id)}/payments/${enc(paymentId)}`),
    applyAction: (id, paymentId, action) =>
      request<{ payment: PaymentView }>(
        'POST',
        `/sandboxes/${enc(id)}/payments/${enc(paymentId)}/actions`,
        action,
      ),
    listWebhooks: (id) => request<WebhookDeliveryView[]>('GET', `/sandboxes/${enc(id)}/webhooks`),
    replayWebhook: (id, webhookId) =>
      request<OkResponse>('POST', `/sandboxes/${enc(id)}/webhooks/${enc(webhookId)}/replay`),
    getFaults: (id) => request<FaultProfile>('GET', `/sandboxes/${enc(id)}/faults`),
    setFaults: (id, profile) =>
      request<FaultProfile>('PUT', `/sandboxes/${enc(id)}/faults`, profile),
  };
}
