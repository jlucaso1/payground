import type { DocumentKind } from '@payground/core/store.ts';
import type { ApiError, ApiResult, FetchLike } from './client.ts';
import { API_PREFIX } from './client.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Keyed by the core union so a new kind in the store fails to typecheck here until it is listed. */
const KIND_ORDER: Record<DocumentKind, true> = {
  card_token: true,
  preference: true,
  merchant_order: true,
  customer: true,
  customer_card: true,
  customer_address: true,
  preapproval_plan: true,
  preapproval: true,
  authorized_payment: true,
  order: true,
  advanced_payment: true,
  chargeback: true,
  store: true,
  pos: true,
  terminal: true,
  point_intent: true,
  qr_order: true,
  qr_config: true,
  wallet_agreement: true,
  payout: true,
  transaction_intent: true,
  claim: true,
  claim_message: true,
  report: true,
  report_config: true,
  report_task: true,
};

export const DOCUMENT_KINDS: readonly DocumentKind[] = Object.keys(KIND_ORDER) as DocumentKind[];

export type { DocumentKind };

export interface StoredDocument {
  kind: string;
  id: string;
  sequence: number;
  status: string;
  externalReference: string | null;
  lookup: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  doc: JsonObject;
}

export interface DocumentPage {
  total: number;
  limit: number;
  offset: number;
  results: StoredDocument[];
}

export interface KindCount {
  kind: string;
  count: number;
}

export interface DocumentQuery {
  kind?: string;
  status?: string;
  external_reference?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export function buildDocumentQuery(query: DocumentQuery): string {
  const params = new URLSearchParams();
  const text = (key: 'kind' | 'status' | 'external_reference' | 'q'): void => {
    const value = query[key];
    if (value !== undefined && value !== '') params.set(key, value);
  };
  text('kind');
  text('status');
  text('external_reference');
  text('q');
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

/**
 * The control API may predate the documents endpoints. Its unrouted 404 body differs from the
 * "sandbox not found" one, which must stay a real error.
 */
export function isUnavailable(error: ApiError): boolean {
  if (error.kind === 'parse') return true;
  return error.kind === 'http' && error.status === 404 && !error.message.includes('sandbox');
}

export interface DocumentsClient {
  listKinds(sandboxId: string): Promise<ApiResult<KindCount[]>>;
  listDocuments(sandboxId: string, query?: DocumentQuery): Promise<ApiResult<DocumentPage>>;
  getDocument(sandboxId: string, kind: string, docId: string): Promise<ApiResult<StoredDocument>>;
}

export interface DocumentsClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  token?: () => string | null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createDocumentsClient(options: DocumentsClientOptions = {}): DocumentsClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const token = options.token ?? (() => null);

  async function request<T>(path: string): Promise<ApiResult<T>> {
    let response: Response;
    try {
      const admin = token();
      const headers: Record<string, string> = { accept: 'application/json' };
      if (admin !== null && admin !== '') headers['authorization'] = `Bearer ${admin}`;
      response = await doFetch(`${baseUrl}${API_PREFIX}${path}`, { method: 'GET', headers });
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
    listKinds: (sandboxId) => request<KindCount[]>(`/sandboxes/${enc(sandboxId)}/documents/kinds`),
    listDocuments: (sandboxId, query = {}) =>
      request<DocumentPage>(`/sandboxes/${enc(sandboxId)}/documents${buildDocumentQuery(query)}`),
    getDocument: (sandboxId, kind, docId) =>
      request<StoredDocument>(`/sandboxes/${enc(sandboxId)}/documents/${enc(kind)}/${enc(docId)}`),
  };
}
