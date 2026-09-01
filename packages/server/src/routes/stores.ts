import {
  createPOS,
  createStore,
  deletePOS,
  deleteStore,
  getPOS,
  getStore,
  listPOS,
  posQrPage,
  posQrPng,
  searchPOS,
  searchStores,
  updatePOS,
  updateStore,
} from '@payground/mercadopago/api/stores.ts';
import { contextFor, endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

/** Stores and points of sale. */
export const stores: RouteModule = {
  name: 'stores',
  operations: [
    'createStore',
    'getStore',
    'searchStores',
    'updateStore',
    'deleteStore',
    'searchPOS',
    'createPOS',
    'getPOS',
    'updatePOS',
    'deletePOS',
    'listPOS',
  ],
  pending: [],
  routes: ({ runtime, storage, param }) => {
    /** The QR pages are opened by a browser, like the payment ticket, so they carry no token. */
    const browserContext = () => {
      const sandbox = storage.sandboxes.list()[0];
      return sandbox === undefined ? null : contextFor(runtime, sandbox);
    };

    return {
      '/users/:user_id/stores': {
        POST: endpoint(runtime, ({ service, request, body }) =>
          fromResult(createStore(service, param(request, 'user_id'), body)),
        ),
      },
      '/users/:user_id/stores/search': {
        GET: endpoint(runtime, ({ service, request, url }) =>
          fromResult(searchStores(service, param(request, 'user_id'), url.searchParams)),
        ),
      },
      '/users/:user_id/stores/:id': {
        PUT: endpoint(runtime, ({ service, request, body }) =>
          fromResult(updateStore(service, param(request, 'user_id'), param(request, 'id'), body)),
        ),
        DELETE: endpoint(runtime, ({ service, request }) =>
          fromResult(deleteStore(service, param(request, 'user_id'), param(request, 'id'))),
        ),
      },
      '/stores/:id': {
        GET: endpoint(runtime, ({ service, request }) => fromResult(getStore(service, param(request, 'id')))),
      },
      '/users/:user_id/pos': {
        GET: endpoint(runtime, ({ service, request, url }) =>
          fromResult(listPOS(service, param(request, 'user_id'), url.searchParams)),
        ),
      },
      '/pos': {
        GET: endpoint(runtime, ({ service, url }) => fromResult(searchPOS(service, url.searchParams))),
        POST: endpoint(runtime, ({ service, body }) => fromResult(createPOS(service, body))),
      },
      '/pos/:id': {
        GET: endpoint(runtime, ({ service, request }) => fromResult(getPOS(service, param(request, 'id')))),
        PUT: endpoint(runtime, ({ service, request, body }) =>
          fromResult(updatePOS(service, param(request, 'id'), body)),
        ),
        DELETE: endpoint(runtime, ({ service, request }) => fromResult(deletePOS(service, param(request, 'id')))),
      },
      '/pos/:id/qr': {
        GET: (request: Request) => {
          const context = browserContext();
          if (context === null) return new Response('no sandbox', { status: 404 });
          const rendered = posQrPage(context, param(request, 'id'));
          return rendered.ok
            ? new Response(rendered.value.html, {
                status: rendered.value.status,
                headers: { 'content-type': 'text/html; charset=utf-8' },
              })
            : Response.json(rendered.error, { status: rendered.error.status });
        },
      },
      '/pos/:id/qr.png': {
        GET: (request: Request) => {
          const context = browserContext();
          if (context === null) return new Response('no sandbox', { status: 404 });
          const rendered = posQrPng(context, param(request, 'id'), new URL(request.url).searchParams.get('scale'));
          return rendered.ok
            ? new Response(rendered.value, { status: 200, headers: { 'content-type': 'image/png' } })
            : Response.json(rendered.error, { status: rendered.error.status });
        },
      },
    };
  },
};
