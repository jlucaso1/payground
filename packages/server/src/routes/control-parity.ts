import type { RouteModule } from './module.ts';

/** Parity report and strict-mode diagnostics for the control API. Control routes serve no spec operation, so both lists stay empty. */
export const controlParity: RouteModule = {
  name: "control-parity",
  operations: [],
  pending: [],
  routes: () => ({}),
};
