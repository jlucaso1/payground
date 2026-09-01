import { type RouteModule, notImplemented } from './module.ts';

/** OAuth, identification types, installments and the collector profile. */
export const identity: RouteModule = {
  name: "identity",
  operations: [],
  pending: notImplemented(
    [
      "createOAuthToken",
      "listIdentificationTypes",
      "getInstallments",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
