import { type RouteModule, notImplemented } from './module.ts';

/** Stores and points of sale. */
export const stores: RouteModule = {
  name: "stores",
  operations: [],
  pending: notImplemented(
    [
      "createStore",
      "getStore",
      "searchStores",
      "updateStore",
      "deleteStore",
      "searchPOS",
      "createPOS",
      "getPOS",
      "updatePOS",
      "deletePOS",
      "listPOS",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
