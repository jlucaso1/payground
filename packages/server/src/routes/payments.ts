import {
  createPayment,
  createRefund,
  getPayment,
  listRefunds,
  searchPayments,
  updatePayment,
} from '@payground/mercadopago/api/payments.ts';
import { endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

export const payments: RouteModule = {
  name: 'payments',
  operations: [
    'createPayment',
    'getPayment',
    'updatePayment',
    'searchPayments',
    'createRefund',
    'listRefunds',
  ],
  pending: [],
  routes: ({ runtime, param }) => ({
    '/v1/payments': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createPayment(service, body)), {
        idempotency: 'required',
      }),
    },
    '/v1/payments/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchPayments(service, url.searchParams))),
    },
    '/v1/payments/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getPayment(service, param(request, 'id')))),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updatePayment(service, param(request, 'id'), body)),
      ),
    },
    '/v1/payments/:id/refunds': {
      POST: endpoint(
        runtime,
        ({ service, request, body }) => fromResult(createRefund(service, param(request, 'id'), body)),
        { idempotency: 'optional' },
      ),
      GET: endpoint(runtime, ({ service, request }) => fromResult(listRefunds(service, param(request, 'id')))),
    },
  }),
};
