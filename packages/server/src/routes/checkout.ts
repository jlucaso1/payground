import {
  createMerchantOrder,
  getMerchantOrder,
  searchMerchantOrders,
  updateMerchantOrder,
} from '@payground/mercadopago/api/merchant-orders.ts';
import {
  createPreference,
  getPreference,
  searchPreferences,
  updatePreference,
} from '@payground/mercadopago/api/preferences.ts';
import { checkoutPage, checkoutSubmit } from '@payground/mercadopago/checkout/page.ts';
import { contextFor, endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

export const checkout: RouteModule = {
  name: 'checkout',
  operations: [
    'createPreference',
    'getPreference',
    'updatePreference',
    'searchPreferences',
    'createMerchantOrder',
    'getMerchantOrder',
    'updateMerchantOrder',
    'searchMerchantOrders',
  ],
  pending: [],
  routes: ({ runtime, storage, param }) => {
    /** The hosted checkout page stands in for the Mercado Pago redirect flow. */
    const hosted = async (request: Request, preferenceId: string): Promise<Response> => {
      const sandbox = storage.sandboxes.list()[0];
      if (sandbox === undefined) return new Response('no sandbox', { status: 404 });
      const service = contextFor(runtime, sandbox);

      if (request.method === 'GET') {
        const rendered = checkoutPage(service, preferenceId);
        return rendered.ok
          ? new Response(rendered.value.html, {
              status: rendered.value.status,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          : Response.json(rendered.error, { status: rendered.error.status });
      }

      const form = new URLSearchParams(await request.text());
      const submitted = checkoutSubmit(service, preferenceId, form);
      if (!submitted.ok) return Response.json(submitted.error, { status: submitted.error.status });
      if (submitted.value.redirect !== null) return Response.redirect(submitted.value.redirect, 303);
      return new Response(submitted.value.html, {
        status: submitted.value.status,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    };

    return {
      '/checkout/preferences': {
        POST: endpoint(runtime, ({ service, body }) => fromResult(createPreference(service, body))),
      },
      '/checkout/preferences/search': {
        GET: endpoint(runtime, ({ service, url }) => fromResult(searchPreferences(service, url.searchParams))),
      },
      '/checkout/preferences/:id': {
        GET: endpoint(runtime, ({ service, request }) => fromResult(getPreference(service, param(request, 'id')))),
        PUT: endpoint(runtime, ({ service, request, body }) =>
          fromResult(updatePreference(service, param(request, 'id'), body)),
        ),
      },
      '/merchant_orders': {
        POST: endpoint(runtime, ({ service, body }) => fromResult(createMerchantOrder(service, body))),
      },
      '/merchant_orders/search': {
        GET: endpoint(runtime, ({ service, url }) => fromResult(searchMerchantOrders(service, url.searchParams))),
      },
      '/merchant_orders/:id': {
        GET: endpoint(runtime, ({ service, request }) => fromResult(getMerchantOrder(service, param(request, 'id')))),
        PUT: endpoint(runtime, ({ service, request, body }) =>
          fromResult(updateMerchantOrder(service, param(request, 'id'), body)),
        ),
      },
      '/checkout/:id': {
        GET: (request: Request) => hosted(request, param(request, 'id')),
        POST: (request: Request) => hosted(request, param(request, 'id')),
      },
    };
  },
};
