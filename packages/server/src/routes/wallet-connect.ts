import { type RouteModule, notImplemented } from './module.ts';

/** Wallet Connect agreements, payer tokens, discounts and coupons. */
export const walletConnect: RouteModule = {
  name: "wallet-connect",
  operations: [],
  pending: notImplemented(
    [
      "createWalletAgreement",
      "getWalletAgreement",
      "deleteWalletAgreement",
      "createWalletPayerToken",
      "createWalletDiscount",
      "validateWalletCoupon",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
