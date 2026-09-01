import { type RouteModule, notImplemented } from './module.ts';

/** In-store QR orders and integrator configuration. */
export const qr: RouteModule = {
  name: "qr",
  operations: [],
  pending: notImplemented(
    [
      "getInstoreOrderV2",
      "deleteInstoreOrderV2",
      "createInstoreOrderV1",
      "deleteInstoreOrderV1",
      "createInstoreOrderV2",
      "createQRTrammaDynamic",
      "createDynamicQROrder",
      "createQRIntegratorConfig",
      "getQRIntegratorConfig",
      "confirmCashoutQR",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
