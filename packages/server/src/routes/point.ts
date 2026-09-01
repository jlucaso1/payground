import { type RouteModule, notImplemented } from './module.ts';

/** Point devices, payment intents and terminals. */
export const point: RouteModule = {
  name: "point",
  operations: [],
  pending: notImplemented(
    [
      "listPointDevices",
      "createPointPaymentIntent",
      "cancelPointPaymentIntent",
      "getPointPaymentIntent",
      "createPointRefundIntent",
      "cancelPointRefundIntent",
      "getPointRefundIntent",
      "listTerminals",
      "updateTerminalOperationMode",
      "createTerminalAction",
      "getTerminalAction",
      "cancelTerminalAction",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
