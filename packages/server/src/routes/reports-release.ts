import {
  createReleaseReport,
  createReleaseReportConfig,
  disableReleaseReportSchedule,
  downloadReleaseReport,
  enableReleaseReportSchedule,
  getReleaseReport,
  getReleaseReportConfig,
  getReleaseReportTask,
  listScheduledReleaseReports,
  searchReleaseReports,
  updateReleaseReportConfig,
} from '@payground/mercadopago/api/reports-release.ts';
import { errorBody, errorResponse, serverError, tooManyRequests } from '@payground/mercadopago/errors.ts';
import type { Sandbox } from '@payground/core';
import { authenticate } from '../http/auth.ts';
import { contextFor, endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

/** Release (money release) reports. */
export const reportsRelease: RouteModule = {
  name: 'reports-release',
  operations: [
    'createReleaseReportConfig',
    'updateReleaseReportConfig',
    'getReleaseReportConfig',
    'createReleaseReport',
    'getReleaseReport',
    'searchReleaseReports',
    'getReleaseReportTask',
    'enableReleaseReportSchedule',
    'disableReleaseReportSchedule',
    'listScheduledReleaseReports',
    'downloadReleaseReport',
  ],
  pending: [],
  routes: ({ runtime, storage, param }) => {
    const ROUTE = '/v1/account/release_report/:file_name';

    /**
     * The file is CSV, so it cannot go through the JSON `endpoint` wrapper; the guards that
     * wrapper applies — auth, faults, rate limiting, metrics and request history — are repeated
     * here so the download is not the one spec operation that escapes them.
     */
    const serve = async (
      request: Request,
      url: URL,
      observed: { sandbox: Sandbox | null },
    ): Promise<Response> => {
      const principal = authenticate(storage.sandboxes, request, url);
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
        return errorResponse(
          errorBody(503, 'service_unavailable', 'service unavailable', [
            { code: 5001, description: 'injected outage' },
          ]),
        );
      }
      if (faults.errorRate > 0 && runtime.random.int(10_000) < faults.errorRate * 10_000) {
        return errorResponse(serverError('injected failure'));
      }
      if (faults.latencyMs > 0) await Bun.sleep(faults.latencyMs);

      const file = downloadReleaseReport(service, param(request, 'file_name'));
      if (!file.ok) return errorResponse(file.error);

      return new Response(file.value.body, {
        headers: {
          'content-type': file.value.contentType,
          'content-disposition': `attachment; filename="${file.value.fileName}"`,
        },
      });
    };

    const download = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const started = runtime.clock.now();
      const observed: { sandbox: Sandbox | null } = { sandbox: null };

      const response = await serve(request, url, observed);
      const durationMs = Math.max(runtime.clock.now() - started, 0);
      const labels = {
        route: ROUTE,
        method: 'GET',
        status: String(response.status),
        sandbox: observed.sandbox?.id ?? 'anonymous',
      };
      runtime.metrics.count('payground_api_requests_total', labels);
      runtime.metrics.observe('payground_api_request_duration_ms', labels, durationMs);
      runtime.requests.record({
        id: runtime.ids.uuid(),
        at: started,
        sandbox: observed.sandbox?.id ?? null,
        method: 'GET',
        route: ROUTE,
        path: url.pathname,
        status: response.status,
        durationMs,
        // The body is a report file, not something worth keeping in the history.
        requestBody: null,
        responseBody: null,
        idempotencyKey: null,
        userAgent: request.headers.get('user-agent'),
      });
      return response;
    };

    return {
      '/v1/account/release_report/config': {
        GET: endpoint(runtime, ({ service }) => fromResult(getReleaseReportConfig(service))),
        POST: endpoint(runtime, ({ service, body }) => fromResult(createReleaseReportConfig(service, body))),
        PUT: endpoint(runtime, ({ service, body }) => fromResult(updateReleaseReportConfig(service, body))),
      },
      '/v1/account/release_report': {
        GET: endpoint(runtime, ({ service }) => fromResult(getReleaseReport(service))),
        POST: endpoint(runtime, ({ service, body }) => fromResult(createReleaseReport(service, body))),
      },
      '/v1/account/release_report/search': {
        GET: endpoint(runtime, ({ service, url }) => fromResult(searchReleaseReports(service, url.searchParams))),
      },
      '/v1/account/release_report/list': {
        GET: endpoint(runtime, ({ service }) => fromResult(listScheduledReleaseReports(service))),
      },
      '/v1/account/release_report/schedule': {
        POST: endpoint(runtime, ({ service, body }) => fromResult(enableReleaseReportSchedule(service, body))),
        DELETE: endpoint(runtime, ({ service }) => fromResult(disableReleaseReportSchedule(service))),
      },
      '/v1/account/release_report/task/:task_id': {
        GET: endpoint(runtime, ({ service, request }) =>
          fromResult(getReleaseReportTask(service, param(request, 'task_id'))),
        ),
      },
      '/v1/account/release_report/:file_name': {
        GET: download,
      },
    };
  },
};
