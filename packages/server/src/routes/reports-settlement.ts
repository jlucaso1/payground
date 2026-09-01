import { type RouteModule, notImplemented } from './module.ts';

/** Settlement reports. */
export const reportsSettlement: RouteModule = {
  name: "reports-settlement",
  operations: [],
  pending: notImplemented(
    [
      "createSettlementReportConfig",
      "updateSettlementReportConfig",
      "getSettlementReportConfig",
      "createSettlementReport",
      "getSettlementReport",
      "searchSettlementReports",
      "getSettlementReportTask",
      "enableSettlementReportSchedule",
      "disableSettlementReportSchedule",
      "listScheduledSettlementReports",
      "downloadSettlementReport",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
