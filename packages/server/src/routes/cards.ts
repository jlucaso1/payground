import { createCardToken, getCardToken } from '@payground/mercadopago/api/card-tokens.ts';
import { listPaymentMethods } from '@payground/mercadopago/api/payment-methods.ts';
import { paymentTicket } from '@payground/mercadopago/api/ticket.ts';
import { contextFor, endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

export const cards: RouteModule = {
  name: 'cards',
  operations: ['createCardToken', 'getCardToken', 'listPaymentMethods'],
  pending: [],
  routes: ({ runtime, storage, param }) => ({
    '/v1/card_tokens': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createCardToken(service, body)), {
        accepts: ['access_token', 'public_key'],
      }),
    },
    '/v1/card_tokens/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getCardToken(service, param(request, 'id'))), {
        accepts: ['access_token', 'public_key'],
      }),
    },
    '/v1/payment_methods': {
      GET: endpoint(runtime, ({ service }) => fromResult(listPaymentMethods(service)), {
        accepts: ['access_token', 'public_key'],
      }),
    },
    '/payments/:id/ticket': {
      GET: (request: Request) => {
        const sandbox = storage.sandboxes.list()[0];
        if (sandbox === undefined) return new Response('no sandbox', { status: 404 });
        const rendered = paymentTicket(contextFor(runtime, sandbox), param(request, 'id'));
        return rendered.ok
          ? new Response(rendered.value.html, {
              status: rendered.value.status,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          : Response.json(rendered.error, { status: rendered.error.status });
      },
    },
  }),
};
