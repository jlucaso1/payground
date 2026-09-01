import type { Sandbox } from '@payground/core';
import type { ServiceContext } from '@payground/mercadopago/api/context.ts';
import {
  type EvidenceType,
  MAX_ATTACHMENT_BYTES,
  type UploadedFile,
  attachClaimFile,
  downloadClaimFile,
  evidenceType,
  getClaim,
  getClaimEvidence,
  getClaimFile,
  getClaimHistory,
  getClaimMediationResolutions,
  getClaimMessages,
  getClaimReasons,
  openClaim,
  requestClaimMediation,
  resolveClaim,
  searchClaims,
  sendClaimMessage,
  uploadEvidenceFile,
  uploadShippingEvidence,
} from '@payground/mercadopago/api/claims.ts';
import {
  type ErrorBody,
  badRequest,
  errorResponse,
  serverError,
  tooManyRequests,
} from '@payground/mercadopago/errors.ts';
import { authenticate } from '../http/auth.ts';
import {
  type AppRuntime,
  contextFor,
  endpoint,
  fromResult,
  normaliseRoute,
  serviceFor,
} from '../http/handler.ts';
import type { RouteModule } from './module.ts';

/** Reads at most `limit` bytes, cancelling the stream instead of buffering the rest. */
async function boundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;

  const body = request.body;
  if (body === null) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The cap is on the file; the boundary, part headers and delimiter need room on top of it. */
const MULTIPART_OVERHEAD = 64 * 1024;
const MAX_UPLOAD_BYTES = MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD;

const TOO_LARGE: ErrorBody = badRequest('the upload exceeds the maximum size', [
  { code: 4004, description: `max ${MAX_ATTACHMENT_BYTES} bytes` },
]);

interface Multipart {
  file: UploadedFile;
  field(name: string): string | null;
}

const isMultipart = (request: Request): boolean =>
  (request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data');

async function readMultipart(request: Request): Promise<Multipart | ErrorBody> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!isMultipart(request)) {
    return badRequest('the body must be multipart/form-data', [{ code: 4012, description: 'content-type' }]);
  }

  const bytes = await boundedBody(request, MAX_UPLOAD_BYTES);
  if (bytes === null) return TOO_LARGE;

  let form: Awaited<ReturnType<Response['formData']>>;
  try {
    form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return badRequest('the multipart body could not be parsed', [{ code: 4013, description: 'body' }]);
  }

  const part = form.get('file');
  if (!(part instanceof Blob)) {
    return badRequest('a file part is required', [{ code: 4014, description: 'file' }]);
  }

  return {
    file: {
      fileName: part instanceof File ? part.name : 'file',
      contentType: part.type,
      bytes: new Uint8Array(await part.arrayBuffer()),
    },
    field: (name) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : null;
    },
  };
}

/**
 * `endpoint` reads the body as JSON, which would corrupt a multipart upload, and always
 * answers in JSON, which a download cannot. This repeats its authentication, rate limiting,
 * fault injection, metrics and history so those routes are not a hole in any of them.
 */
function raw(
  runtime: AppRuntime,
  handler: (scope: { service: ServiceContext; request: Request }) => Promise<Response>,
) {
  const run = async (
    request: Request,
    url: URL,
    observed: { sandbox: Sandbox | null },
  ): Promise<Response> => {
    const principal = authenticate(runtime.storage.sandboxes, request, url, ['access_token']);
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

    try {
      return await handler({ service, request });
    } catch (error) {
      return errorResponse(serverError(error instanceof Error ? error.message : String(error)));
    }
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const started = runtime.clock.now();
    const observed: { sandbox: Sandbox | null } = { sandbox: null };

    const response = await run(request, url, observed);
    const durationMs = Math.max(runtime.clock.now() - started, 0);
    const route = normaliseRoute(url.pathname);
    const labels = {
      route,
      method: request.method,
      status: String(response.status),
      sandbox: observed.sandbox?.id ?? 'anonymous',
    };
    runtime.metrics.count('payground_api_requests_total', labels);
    runtime.metrics.observe('payground_api_request_duration_ms', labels, durationMs);
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
      // The body is a file either way, so it is never kept.
      responseBody: null,
      idempotencyKey: request.headers.get('x-idempotency-key'),
      userAgent: request.headers.get('user-agent'),
    });

    return response;
  };
}

/** Post-purchase claims, messages, evidence and mediation. */
export const claims: RouteModule = {
  name: 'claims',
  operations: [
    'getClaim',
    'searchClaims',
    'getClaimReasons',
    'getClaimHistory',
    'getClaimEvidence',
    'getClaimMessages',
    'sendClaimMessage',
    'attachClaimFile',
    'getClaimFile',
    'downloadClaimFile',
    'requestClaimMediation',
    'getClaimMediationResolutions',
    'uploadShippingEvidence',
  ],
  pending: [],
  routes: ({ runtime, param, admin, json }) => ({
    '/post-purchase/v1/claims/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchClaims(service, url.searchParams))),
    },
    '/post-purchase/v1/claims/reasons/:reason_id': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getClaimReasons(service, param(request, 'reason_id'))),
      ),
    },
    '/post-purchase/v1/claims/:claim_id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getClaim(service, param(request, 'claim_id')))),
    },
    '/post-purchase/v1/claims/:claim_id/status_history': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getClaimHistory(service, param(request, 'claim_id'))),
      ),
    },
    '/post-purchase/v1/claims/:claim_id/evidences': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getClaimEvidence(service, param(request, 'claim_id'))),
      ),
    },
    '/post-purchase/v1/claims/:claim_id/messages': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getClaimMessages(service, param(request, 'claim_id'))),
      ),
    },
    '/post-purchase/v1/claims/:claim_id/actions/send-message': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(sendClaimMessage(service, param(request, 'claim_id'), body)),
      ),
    },
    '/post-purchase/v1/claims/:claim_id/actions/open-dispute': {
      POST: endpoint(runtime, ({ service, request }) =>
        fromResult(requestClaimMediation(service, param(request, 'claim_id'))),
      ),
    },
    '/post-purchase/v1/claims/:claim_id/expected-resolutions': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getClaimMediationResolutions(service, param(request, 'claim_id'))),
      ),
    },
    '/post-purchase/v1/claims/:claim_id/attachments': {
      POST: raw(runtime, async ({ service, request }) => {
        const parsed = await readMultipart(request);
        if (!('file' in parsed)) return errorResponse(parsed);
        const result = attachClaimFile(service, param(request, 'claim_id'), parsed.file);
        return result.ok
          ? Response.json(result.value.body, { status: result.value.status })
          : errorResponse(result.error);
      }),
    },
    '/post-purchase/v1/claims/:claim_id/actions/evidences': {
      POST: raw(runtime, async ({ service, request }) => {
        const claimId = param(request, 'claim_id');
        if (!isMultipart(request)) {
          // The spec's body is JSON; a file is the payground extension below.
          const text = await request.text();
          let body: unknown = {};
          try {
            body = text === '' ? {} : JSON.parse(text);
          } catch {
            return errorResponse(badRequest('the body must be a Json Object'));
          }
          const posted = uploadShippingEvidence(service, claimId, body);
          return posted.ok
            ? Response.json(posted.value.body, { status: posted.value.status })
            : errorResponse(posted.error);
        }

        const parsed = await readMultipart(request);
        if (!('file' in parsed)) return errorResponse(parsed);
        const type: EvidenceType = evidenceType(parsed.field('type'));
        const result = uploadEvidenceFile(service, claimId, parsed.file, type, parsed.field('description'));
        return result.ok
          ? Response.json(result.value.body, { status: result.value.status })
          : errorResponse(result.error);
      }),
    },
    '/post-purchase/v1/claims/:claim_id/attachments/:fileName': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getClaimFile(service, param(request, 'claim_id'), param(request, 'fileName'))),
      ),
    },
    '/post-purchase/v1/claims/:claim_id/attachments/:fileName/download': {
      GET: raw(runtime, async ({ service, request }) => {
        const result = downloadClaimFile(service, param(request, 'claim_id'), param(request, 'fileName'));
        if (!result.ok) return errorResponse(result.error);
        const { fileName, contentType, bytes } = result.value;
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': contentType,
            'content-length': String(bytes.byteLength),
            'content-disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          },
        });
      }),
    },

    // payground-only: the real API opens and resolves a claim from the Mercado Pago front
    // end, so the dashboard and tests drive both from the control namespace instead.
    '/_payground/sandboxes/:id/claims': {
      POST: admin(async (request) => {
        const service = serviceFor(runtime, runtime.storage.sandboxes, param(request, 'id'));
        if (service === null) return Response.json({ error: 'sandbox not found' }, { status: 404 });
        const result = openClaim(service, await json(request));
        return result.ok
          ? Response.json(result.value.body, { status: result.value.status })
          : errorResponse(result.error);
      }),
    },
    '/_payground/sandboxes/:id/claims/:claim_id/resolve': {
      POST: admin(async (request) => {
        const service = serviceFor(runtime, runtime.storage.sandboxes, param(request, 'id'));
        if (service === null) return Response.json({ error: 'sandbox not found' }, { status: 404 });
        const body = await json(request);
        const outcome =
          body !== null && typeof body === 'object' && (body as { outcome?: unknown }).outcome === 'respondent'
            ? 'respondent'
            : 'complainant';
        const result = resolveClaim(service, param(request, 'claim_id'), outcome);
        return result.ok
          ? Response.json(result.value.body, { status: result.value.status })
          : errorResponse(result.error);
      }),
    },
  }),
};
