import { type RouteModule, notImplemented } from './module.ts';

/** Chargebacks, advanced payments and the remaining payment operations. */
export const disputes: RouteModule = {
  name: "disputes",
  operations: [],
  pending: notImplemented(
    [
      "getChargeback",
      "updateChargeback",
      "createAdvancedPayment",
      "getAdvancedPayment",
      "updateAdvancedPayment",
      "getRefund",
      "cancelPayment",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
