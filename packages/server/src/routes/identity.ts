import {
  createOAuthToken,
  getCollectorUser,
  getInstallments,
  listIdentificationTypes,
  oauthClient,
} from '@payground/mercadopago/api/identity.ts';
import { errorResponse } from '@payground/mercadopago/errors.ts';
import { contextFor, endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

const bearerOf = (request: Request): string | null => {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  return match?.[1]?.trim() ?? null;
};

/** The real endpoint takes JSON or a form body; the Node SDK posts JSON. */
async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === '') return {};
  if (request.headers.get('content-type')?.includes('application/x-www-form-urlencoded') === true) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** OAuth, identification types, installments and the collector profile. */
export const identity: RouteModule = {
  name: 'identity',
  operations: ['createOAuthToken', 'listIdentificationTypes', 'getInstallments'],
  pending: [],
  routes: ({ runtime, storage }) => ({
    /** Unauthenticated per the spec: the sandbox comes from `client_secret`. */
    '/oauth/token': {
      POST: async (request: Request): Promise<Response> => {
        const body = await readBody(request);
        const client = oauthClient(body, bearerOf(request));
        if (!client.ok) return errorResponse(client.error);

        const sandbox = storage.sandboxes.byAccessToken(client.value.clientSecret);
        if (sandbox === null) {
          return errorResponse({
            message: 'invalid client_secret',
            error: 'invalid_client',
            status: 400,
            cause: [{ code: 'invalid_client', description: 'invalid client_secret' }],
          });
        }

        const issued = createOAuthToken(contextFor(runtime, sandbox), body);
        return issued.ok
          ? Response.json(issued.value.body, { status: issued.value.status })
          : errorResponse(issued.error);
      },
    },
    /** MercadoPago.js calls both of these from the browser, with the public key. */
    '/v1/identification_types': {
      GET: endpoint(runtime, ({ service }) => fromResult(listIdentificationTypes(service)), {
        accepts: ['access_token', 'public_key'],
      }),
    },
    '/v1/payment_methods/installments': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(getInstallments(service, url.searchParams)), {
        accepts: ['access_token', 'public_key'],
      }),
    },
    '/users/me': {
      GET: endpoint(runtime, ({ service }) => fromResult(getCollectorUser(service))),
    },
  }),
};
