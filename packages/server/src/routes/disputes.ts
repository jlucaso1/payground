import {
  createAdvancedPayment,
  getAdvancedPayment,
  updateAdvancedPayment,
} from '@payground/mercadopago/api/advanced-payments.ts';
import {
  cancelPayment,
  getChargeback,
  getRefund,
  updateChargeback,
} from '@payground/mercadopago/api/disputes.ts';
import { endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

/** Chargebacks, advanced payments and the remaining payment operations. */
export const disputes: RouteModule = {
  name: 'disputes',
  operations: [
    'getChargeback',
    'updateChargeback',
    'createAdvancedPayment',
    'getAdvancedPayment',
    'updateAdvancedPayment',
    'getRefund',
    'cancelPayment',
  ],
  pending: [],
  routes: ({ runtime, param }) => ({
    '/v1/chargebacks/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getChargeback(service, param(request, 'id')))),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updateChargeback(service, param(request, 'id'), body)),
      ),
    },
    '/v1/advanced_payments': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createAdvancedPayment(service, body)), {
        idempotency: 'required',
      }),
    },
    '/v1/advanced_payments/:advanced_payment_id': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getAdvancedPayment(service, param(request, 'advanced_payment_id'))),
      ),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updateAdvancedPayment(service, param(request, 'advanced_payment_id'), body)),
      ),
    },
    '/v1/payments/:id/refunds/:refund_id': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getRefund(service, param(request, 'id'), param(request, 'refund_id'))),
      ),
    },
    '/v1/payments/:id/cancellations': {
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(cancelPayment(service, param(request, 'id'), body)),
      ),
    },
  }),
};
