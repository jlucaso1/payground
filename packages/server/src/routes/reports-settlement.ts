import {
  type ReportFile,
  createSettlementReport,
  createSettlementReportConfig,
  disableSettlementReportSchedule,
  downloadSettlementReport,
  enableSettlementReportSchedule,
  getSettlementReport,
  getSettlementReportConfig,
  getSettlementReportTask,
  listScheduledSettlementReports,
  searchSettlementReports,
  updateSettlementReportConfig,
} from '@payground/mercadopago/api/reports-settlement.ts';
import { endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

/** Settlement reports. */
export const reportsSettlement: RouteModule = {
  name: 'reports-settlement',
  operations: [
    'createSettlementReportConfig',
    'updateSettlementReportConfig',
    'getSettlementReportConfig',
    'createSettlementReport',
    'getSettlementReport',
    'searchSettlementReports',
    'getSettlementReportTask',
    'enableSettlementReportSchedule',
    'disableSettlementReportSchedule',
    'listScheduledSettlementReports',
    'downloadSettlementReport',
  ],
  pending: [],
  routes: ({ runtime, param }) => {
    /**
     * The CSV is not JSON, so the file rides through `endpoint` — which owns authentication,
     * rate limiting, injected faults, metrics and the request history — and is unwrapped
     * afterwards, rather than reimplementing any of that here.
     */
    const file = endpoint(runtime, ({ service, request }) => {
      const found = downloadSettlementReport(service, param(request, 'file_name'));
      return found.ok
        ? { status: 200, body: found.value }
        : { status: found.error.status, body: found.error };
    });

    const download = async (request: Request): Promise<Response> => {
      const response = await file(request);
      if (response.status !== 200) return response;
      const report = (await response.json()) as ReportFile;
      return new Response(report.content, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${report.fileName}"`,
        },
      });
    };

    return {
      '/v1/account/settlement_report/config': {
        GET: endpoint(runtime, ({ service }) => fromResult(getSettlementReportConfig(service))),
        POST: endpoint(runtime, ({ service, body }) => fromResult(createSettlementReportConfig(service, body))),
        PUT: endpoint(runtime, ({ service, body }) => fromResult(updateSettlementReportConfig(service, body))),
      },
      '/v1/account/settlement_report': {
        GET: endpoint(runtime, ({ service, url }) => fromResult(getSettlementReport(service, url.searchParams))),
        POST: endpoint(runtime, ({ service, body }) => fromResult(createSettlementReport(service, body))),
      },
      '/v1/account/settlement_report/search': {
        GET: endpoint(runtime, ({ service, url }) => fromResult(searchSettlementReports(service, url.searchParams))),
      },
      '/v1/account/settlement_report/task/:task_id': {
        GET: endpoint(runtime, ({ service, request }) =>
          fromResult(getSettlementReportTask(service, param(request, 'task_id'))),
        ),
      },
      '/v1/account/settlement_report/schedule': {
        POST: endpoint(runtime, ({ service, body }) => fromResult(enableSettlementReportSchedule(service, body))),
        DELETE: endpoint(runtime, ({ service }) => fromResult(disableSettlementReportSchedule(service))),
      },
      '/v1/account/settlement_report/list': {
        GET: endpoint(runtime, ({ service }) => fromResult(listScheduledSettlementReports(service))),
      },
      '/v1/account/settlement_report/:file_name': {
        GET: download,
      },
    };
  },
};
