import {
  cancelPayoutTransaction,
  createPayout,
  getTransactionIntent,
  listPayoutTransactions,
  processTransactionIntent,
} from '@payground/mercadopago/api/payouts.ts';
import { endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

/** Payouts and transaction intents. */
export const payouts: RouteModule = {
  name: 'payouts',
  operations: [
    'createPayout',
    'listPayoutTransactions',
    'cancelPayoutTransaction',
    'processTransactionIntent',
    'getTransactionIntent',
  ],
  pending: [],
  routes: ({ runtime, param }) => ({
    '/v1/payouts': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createPayout(service, body)), {
        idempotency: 'optional',
      }),
    },
    '/v1/payouts/:id/transactions': {
      GET: endpoint(runtime, ({ service, request, url }) =>
        fromResult(listPayoutTransactions(service, param(request, 'id'), url.searchParams)),
      ),
    },
    '/v1/payouts/:id/transactions/:tid/cancel': {
      PUT: endpoint(runtime, ({ service, request }) =>
        fromResult(cancelPayoutTransaction(service, param(request, 'id'), param(request, 'tid'))),
      ),
    },
    '/v1/transaction-intents/process': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(processTransactionIntent(service, body)), {
        idempotency: 'optional',
      }),
    },
    '/v1/transaction-intents/:id': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getTransactionIntent(service, param(request, 'id'))),
      ),
    },
  }),
};
