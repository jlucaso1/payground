import {
  createCustomer,
  createCustomerAddress,
  deleteCard,
  deleteCustomer,
  deleteCustomerAddress,
  getCard,
  getCustomer,
  getCustomerAddress,
  listCards,
  listCustomerAddresses,
  saveCard,
  searchCustomers,
  updateCard,
  updateCustomer,
  updateCustomerAddress,
} from '@payground/mercadopago/api/customers.ts';
import { endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

/** Customers, saved cards and addresses. */
export const customers: RouteModule = {
  name: 'customers',
  operations: [
    'createCustomer',
    'searchCustomers',
    'getCustomer',
    'updateCustomer',
    'deleteCustomer',
    'saveCard',
    'listCards',
    'getCard',
    'updateCard',
    'deleteCard',
    'createCustomerAddress',
    'listCustomerAddresses',
    'getCustomerAddress',
    'updateCustomerAddress',
    'deleteCustomerAddress',
  ],
  pending: [],
  routes: ({ runtime, param }) => ({
    '/v1/customers': {
      POST: endpoint(runtime, ({ service, body }) => fromResult(createCustomer(service, body))),
    },
    '/v1/customers/search': {
      GET: endpoint(runtime, ({ service, url }) => fromResult(searchCustomers(service, url.searchParams))),
    },
    '/v1/customers/:id': {
      GET: endpoint(runtime, ({ service, request }) => fromResult(getCustomer(service, param(request, 'id')))),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updateCustomer(service, param(request, 'id'), body)),
      ),
      // The spec documents /delete, but the official SDK sends DELETE to the resource itself.
      DELETE: endpoint(runtime, ({ service, request }) => fromResult(deleteCustomer(service, param(request, 'id')))),
    },
    '/v1/customers/:id/delete': {
      DELETE: endpoint(runtime, ({ service, request }) => fromResult(deleteCustomer(service, param(request, 'id')))),
    },
    '/v1/customers/:customer_id/cards': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(listCards(service, param(request, 'customer_id'))),
      ),
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(saveCard(service, param(request, 'customer_id'), body)),
      ),
    },
    '/v1/customers/:customer_id/cards/:id': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getCard(service, param(request, 'customer_id'), param(request, 'id'))),
      ),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(updateCard(service, param(request, 'customer_id'), param(request, 'id'), body)),
      ),
      DELETE: endpoint(runtime, ({ service, request }) =>
        fromResult(deleteCard(service, param(request, 'customer_id'), param(request, 'id'))),
      ),
    },
    '/v1/customers/:customer_id/addresses': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(listCustomerAddresses(service, param(request, 'customer_id'))),
      ),
      POST: endpoint(runtime, ({ service, request, body }) =>
        fromResult(createCustomerAddress(service, param(request, 'customer_id'), body)),
      ),
    },
    '/v1/customers/:customer_id/addresses/:address_id': {
      GET: endpoint(runtime, ({ service, request }) =>
        fromResult(getCustomerAddress(service, param(request, 'customer_id'), param(request, 'address_id'))),
      ),
      PUT: endpoint(runtime, ({ service, request, body }) =>
        fromResult(
          updateCustomerAddress(service, param(request, 'customer_id'), param(request, 'address_id'), body),
        ),
      ),
      DELETE: endpoint(runtime, ({ service, request }) =>
        fromResult(deleteCustomerAddress(service, param(request, 'customer_id'), param(request, 'address_id'))),
      ),
    },
  }),
};
