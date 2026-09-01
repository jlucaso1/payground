import {
  createPlan,
  createSubscription,
  getAuthorizedPayment,
  getPlan,
  getSubscription,
  searchAuthorizedPayments,
  searchPlans,
  exportSubscriptions,
  searchSubscriptions,
  updatePlan,
  updateSubscription,
} from '@payground/mercadopago/api/subscriptions.ts';
import { endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

export const subscriptions: RouteModule = {
  name: 'subscriptions',
  operations: [
    'createSubscriptionPlan',
    'getSubscriptionPlan',
    'updateSubscriptionPlan',
    'searchSubscriptionPlans',
    'createSubscription',
    'getSubscription',
    'updateSubscription',
    'searchSubscriptions',
    'getAuthorizedPayment',
    'searchAuthorizedPayments',
    'exportSubscriptions',
  ],
  pending: [],
  routes: ({ runtime, param }) => {
    /** Rides through `endpoint` for auth, rate limiting, faults, metrics and history,
     *  then is unwrapped into a CSV response. Same shape as the report downloads. */
    const exported = endpoint(runtime, ({ service, url }) => {
      const found = exportSubscriptions(service, url.searchParams);
      return found.ok
        ? { status: 200, body: found.value }
        : { status: found.error.status, body: found.error };
    });

    const download = async (request: Request): Promise<Response> => {
      const response = await exported(request);
      if (response.status !== 200) return response;
      const file = (await response.json()) as { fileName: string; body: string };
      return new Response(file.body, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${file.fileName}"`,
        },
      });
    };

    return {
    '/preapproval_plan': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createPlan(service, body))),
    },
    '/preapproval_plan/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchPlans(service, url.searchParams))),
    },
    '/preapproval_plan/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getPlan(service, param(request, 'id')))),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updatePlan(service, param(request, 'id'), body)),
      ),
    },
    '/preapproval': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createSubscription(service, body))),
    },
    '/preapproval/export': { GET: download },
    '/preapproval/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchSubscriptions(service, url.searchParams))),
    },
    '/preapproval/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getSubscription(service, param(request, 'id')))),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updateSubscription(service, param(request, 'id'), body)),
      ),
    },
    '/authorized_payments': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchAuthorizedPayments(service, url.searchParams))),
    },
    '/authorized_payments/:id': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getAuthorizedPayment(service, param(request, 'id'))),
      ),
    },
  };
  },
};
