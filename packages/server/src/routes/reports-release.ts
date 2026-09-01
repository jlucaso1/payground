import { type RouteModule, notImplemented } from './module.ts';

/** Release (money release) reports. */
export const reportsRelease: RouteModule = {
  name: "reports-release",
  operations: [],
  pending: notImplemented(
    [
      "createReleaseReportConfig",
      "updateReleaseReportConfig",
      "getReleaseReportConfig",
      "createReleaseReport",
      "getReleaseReport",
      "searchReleaseReports",
      "getReleaseReportTask",
      "enableReleaseReportSchedule",
      "disableReleaseReportSchedule",
      "listScheduledReleaseReports",
      "downloadReleaseReport",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
