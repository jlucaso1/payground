import { payments } from './payments.ts';
import { orders } from './orders.ts';
import { checkout } from './checkout.ts';
import { subscriptions } from './subscriptions.ts';
import { cards } from './cards.ts';
import { customers } from './customers.ts';
import { disputes } from './disputes.ts';
import { identity } from './identity.ts';
import { stores } from './stores.ts';
import { point } from './point.ts';
import { qr } from './qr.ts';
import { walletConnect } from './wallet-connect.ts';
import { payouts } from './payouts.ts';
import { claims } from './claims.ts';
import { reportsRelease } from './reports-release.ts';
import { reportsSettlement } from './reports-settlement.ts';
import { controlMetrics } from './control-metrics.ts';
import { controlHistory } from './control-history.ts';
import { controlAdmin } from './control-admin.ts';
import { controlParity } from './control-parity.ts';
import type { RouteModule } from './module.ts';

/** Every Mercado Pago product payground knows about. One module per product. */
export const MODULES: readonly RouteModule[] = [
  payments,
  orders,
  checkout,
  subscriptions,
  cards,
  customers,
  disputes,
  identity,
  stores,
  point,
  qr,
  walletConnect,
  payouts,
  claims,
  reportsRelease,
  reportsSettlement,
  controlMetrics,
  controlHistory,
  controlAdmin,
  controlParity,
];

export { type ModuleDeps, type PendingOperation, type RouteModule, type RouteTable, notImplemented } from './module.ts';
