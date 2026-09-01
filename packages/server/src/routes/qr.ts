import {
  type PosRef,
  confirmCashout,
  createDynamicQr,
  createInstoreOrder,
  deleteInstoreOrder,
  getInstoreOrder,
  getIntegratorConfig,
  updateIntegratorConfig,
} from '@payground/mercadopago/api/qr.ts';
import { endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

/**
 * In-store QR orders and integrator configuration. Every operation but the integrator
 * config and the cash-out confirmation is deprecated in the spec; they stay implemented
 * because live integrations still call them.
 * https://www.mercadopago.com/developers/en/docs/qr-code/orders/create-order
 */
export const qr: RouteModule = {
  name: 'qr',
  operations: [
    'getInstoreOrderV2',
    'deleteInstoreOrderV2',
    'createInstoreOrderV1',
    'deleteInstoreOrderV1',
    'createInstoreOrderV2',
    'createQRTrammaDynamic',
    'createDynamicQROrder',
    'createQRIntegratorConfig',
    'getQRIntegratorConfig',
    'confirmCashoutQR',
  ],
  pending: [],
  routes: ({ runtime, param }) => {
    const ref = (request: Request, pos: string, store: string | null): PosRef => ({
      userId: param(request, 'user_id'),
      externalPosId: param(request, pos),
      externalStoreId: store === null ? null : param(request, store),
    });

    return {
      '/instore/orders/qr/seller/collectors/:user_id/pos/:external_pos_id/qrs': {
        POST: endpoint(runtime, ({ service, request, body }) =>
          fromResult(createDynamicQr(service, ref(request, 'external_pos_id', null), body)),
        ),
        PUT: endpoint(runtime, ({ service, request, body }) =>
          fromResult(createDynamicQr(service, ref(request, 'external_pos_id', null), body)),
        ),
      },
      '/instore/qr/seller/collectors/:user_id/pos/:external_pos_id/orders': {
        GET: endpoint(runtime, ({ service, request }) =>
          fromResult(getInstoreOrder(service, ref(request, 'external_pos_id', null))),
        ),
        DELETE: endpoint(runtime, ({ service, request }) =>
          fromResult(deleteInstoreOrder(service, ref(request, 'external_pos_id', null))),
        ),
      },
      '/instore/qr/seller/collectors/:user_id/stores/:external_store_id/pos/:external_pos_id/orders': {
        PUT: endpoint(runtime, ({ service, request, body }) =>
          fromResult(createInstoreOrder(service, ref(request, 'external_pos_id', 'external_store_id'), body)),
        ),
      },
      // V1 addresses the point of sale as `external_id`, with no store in the path.
      '/mpmobile/instore/qr/:user_id/:external_id': {
        PUT: endpoint(runtime, ({ service, request, body }) =>
          fromResult(createInstoreOrder(service, ref(request, 'external_id', null), body)),
        ),
        DELETE: endpoint(runtime, ({ service, request }) =>
          fromResult(deleteInstoreOrder(service, ref(request, 'external_id', null))),
        ),
      },
      '/instore/integrator': {
        GET: endpoint(runtime, ({ service }) => fromResult(getIntegratorConfig(service))),
        PATCH: endpoint(runtime, ({ service, body }) => fromResult(updateIntegratorConfig(service, body))),
      },
      '/instore/orders/:merchant_order_id/confirmation': {
        POST: endpoint(runtime, ({ service, request, body }) =>
          fromResult(confirmCashout(service, param(request, 'merchant_order_id'), body)),
        ),
      },
    };
  },
};
