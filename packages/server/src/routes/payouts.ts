import { type RouteModule, notImplemented } from './module.ts';

/** Payouts and transaction intents. */
export const payouts: RouteModule = {
  name: "payouts",
  operations: [],
  pending: notImplemented(
    [
      "createPayout",
      "listPayoutTransactions",
      "cancelPayoutTransaction",
      "processTransactionIntent",
      "getTransactionIntent",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
