import type { RouteModule } from './module.ts';

/** Request history and audit trail for the control API. Control routes serve no spec operation, so both lists stay empty. */
export const controlHistory: RouteModule = {
  name: "control-history",
  operations: [],
  pending: [],
  routes: () => ({}),
};
