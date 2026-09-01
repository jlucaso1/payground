import {
  createPlan,
  createSubscription,
  getAuthorizedPayment,
  getPlan,
  getSubscription,
  searchAuthorizedPayments,
  searchPlans,
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
  ],
  pending: [{ operationId: 'exportSubscriptions', reason: 'not implemented yet' }],
  routes: ({ runtime, param }) => ({
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
  }),
};
