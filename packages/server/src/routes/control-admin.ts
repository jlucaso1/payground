import type { RouteModule } from './module.ts';

/** Admin account and credential management for the control API. Control routes serve no spec operation, so both lists stay empty. */
export const controlAdmin: RouteModule = {
  name: "control-admin",
  operations: [],
  pending: [],
  routes: () => ({}),
};
