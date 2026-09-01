import {
  addTransaction,
  cancelOrder,
  captureOrder,
  createOrder,
  deleteTransaction,
  getOrder,
  processOrder,
  refundOrder,
  searchOrders,
  updateTransaction,
} from '@payground/mercadopago/api/orders.ts';
import { endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

export const orders: RouteModule = {
  name: 'orders',
  operations: [
    'createOrder',
    'searchOrders',
    'getOrder',
    'cancelOrder',
    'processOrder',
    'captureOrder',
    'refundOrder',
    'updateOrderTransaction',
    'deleteOrderTransaction',
    'addOrderTransaction',
  ],
  pending: [],
  routes: ({ runtime, param }) => ({
    '/v1/orders': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createOrder(service, body)), {
        idempotency: 'required',
      }),
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchOrders(service, url.searchParams))),
    },
    '/v1/orders/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getOrder(service, param(request, 'id')))),
    },
    '/v1/orders/:id/process': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(processOrder(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/capture': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(captureOrder(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/cancel': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(cancelOrder(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/refund': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(refundOrder(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/transactions': {
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(addTransaction(service, param(request, 'id'), body)),
      ),
    },
    '/v1/orders/:id/transactions/:tid': {
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updateTransaction(service, param(request, 'id'), param(request, 'tid'), body)),
      ),
      DELETE: endpoint(runtime, ({ service, request }) =>
        fromResult(deleteTransaction(service, param(request, 'id'), param(request, 'tid'))),
      ),
    },
  }),
};
