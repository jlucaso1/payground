import type { RouteModule } from './module.ts';

/** Metrics exposition for the control API. Control routes serve no spec operation, so both lists stay empty. */
export const controlMetrics: RouteModule = {
  name: "control-metrics",
  operations: [],
  pending: [],
  routes: () => ({}),
};
