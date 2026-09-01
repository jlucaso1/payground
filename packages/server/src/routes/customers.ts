import { type RouteModule, notImplemented } from './module.ts';

/** Customers, saved cards and addresses. */
export const customers: RouteModule = {
  name: "customers",
  operations: [],
  pending: notImplemented(
    [
      "createCustomer",
      "searchCustomers",
      "getCustomer",
      "updateCustomer",
      "deleteCustomer",
      "saveCard",
      "listCards",
      "getCard",
      "updateCard",
      "deleteCard",
      "createCustomerAddress",
      "listCustomerAddresses",
      "getCustomerAddress",
      "updateCustomerAddress",
      "deleteCustomerAddress",
    ],
    'not implemented yet',
  ),
  routes: () => ({}),
};
