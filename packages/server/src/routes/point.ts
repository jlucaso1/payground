import {
  cancelPointPaymentIntent,
  cancelPointRefundIntent,
  cancelTerminalAction,
  createPointPaymentIntent,
  createPointRefundIntent,
  createTerminalAction,
  driveIntent,
  driveTerminalAction,
  getPointPaymentIntent,
  getPointRefundIntent,
  getTerminalAction,
  listIntents,
  listPointDevices,
  listTerminals,
  updateTerminalOperationMode,
} from '@payground/mercadopago/api/point.ts';
import { isJsonObject } from '@payground/core';
import { endpoint, fromResult, serviceFor } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

const commandOf = (body: unknown): string =>
  isJsonObject(body) && typeof body['command'] === 'string' ? body['command'] : '';

/** Point devices, payment intents and terminals. */
export const point: RouteModule = {
  name: 'point',
  operations: [
    'listPointDevices',
    'createPointPaymentIntent',
    'cancelPointPaymentIntent',
    'getPointPaymentIntent',
    'createPointRefundIntent',
    'cancelPointRefundIntent',
    'getPointRefundIntent',
    'listTerminals',
    'updateTerminalOperationMode',
    'createTerminalAction',
    'getTerminalAction',
    'cancelTerminalAction',
  ],
  pending: [],
  routes: ({ runtime, storage, admin, param, json }) => {
    /** A real reader takes time; the control API stands in for it so tests never sleep. */
    const drive = (name: 'intent' | 'action') =>
      admin(async (request) => {
        const service = serviceFor(runtime, storage.sandboxes, param(request, 'id'));
        if (service === null) return Response.json({ error: 'sandbox not found' }, { status: 404 });
        const command = commandOf(await json(request));
        const result =
          name === 'intent'
            ? driveIntent(service, param(request, 'iid'), command)
            : driveTerminalAction(service, param(request, 'iid'), command);
        return result.ok
          ? Response.json(result.value.body, { status: result.value.status })
          : Response.json(result.error, { status: result.error.status });
      });

    return {
      '/point/integration-api/devices': {
        GET: endpoint(runtime, ({ service, url }) => fromResult(listPointDevices(service, url.searchParams))),
      },
      '/point/integration-api/devices/:deviceid/payment-intents': {
        POST: endpoint(runtime, ({ service, request, body }) =>
          fromResult(createPointPaymentIntent(service, param(request, 'deviceid'), body)),
        ),
      },
      '/point/integration-api/devices/:deviceid/payment-intents/:paymentintentid': {
        DELETE: endpoint(runtime, ({ service, request }) =>
          fromResult(
            cancelPointPaymentIntent(service, param(request, 'deviceid'), param(request, 'paymentintentid')),
          ),
        ),
      },
      '/point/integration-api/payment-intents/:paymentintentid': {
        GET: endpoint(runtime, ({ service, request }) =>
          fromResult(getPointPaymentIntent(service, param(request, 'paymentintentid'))),
        ),
      },
      '/point/integration-api/devices/:deviceid/refund': {
        POST: endpoint(runtime, ({ service, request, body }) =>
          fromResult(createPointRefundIntent(service, param(request, 'deviceid'), body)),
        ),
      },
      '/point/integration-api/devices/:deviceid/refund/:refundintentid': {
        DELETE: endpoint(runtime, ({ service, request }) =>
          fromResult(
            cancelPointRefundIntent(service, param(request, 'deviceid'), param(request, 'refundintentid')),
          ),
        ),
      },
      '/point/integration-api/refund/:refundintentid': {
        GET: endpoint(runtime, ({ service, request }) =>
          fromResult(getPointRefundIntent(service, param(request, 'refundintentid'))),
        ),
      },
      '/terminals/v1/list': {
        GET: endpoint(runtime, ({ service, url }) => fromResult(listTerminals(service, url.searchParams))),
      },
      '/terminals/v1/setup': {
        PATCH: endpoint(runtime, ({ service, body }) => fromResult(updateTerminalOperationMode(service, body))),
      },
      '/terminals/v1/actions': {
        POST: endpoint(runtime, ({ service, body }) => fromResult(createTerminalAction(service, body))),
      },
      '/terminals/v1/actions/:action_id': {
        GET: endpoint(runtime, ({ service, request }) =>
          fromResult(getTerminalAction(service, param(request, 'action_id'))),
        ),
      },
      '/terminals/v1/actions/:action_id/cancel': {
        POST: endpoint(runtime, ({ service, request }) =>
          fromResult(cancelTerminalAction(service, param(request, 'action_id'))),
        ),
      },

      '/_payground/sandboxes/:id/point/intents': {
        GET: admin((request) => {
          const service = serviceFor(runtime, storage.sandboxes, param(request, 'id'));
          if (service === null) return Response.json({ error: 'sandbox not found' }, { status: 404 });
          const result = listIntents(service, new URL(request.url).searchParams);
          return result.ok
            ? Response.json(result.value.body, { status: result.value.status })
            : Response.json(result.error, { status: result.error.status });
        }),
      },
      '/_payground/sandboxes/:id/point/intents/:iid/actions': { POST: drive('intent') },
      '/_payground/sandboxes/:id/point/terminal-actions/:iid/actions': { POST: drive('action') },
    };
  },
};
