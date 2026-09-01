import type { JsonSchema } from '../tools/spec-sync/src/schema.ts';

/**
 * The official spec is structurally correct but materially incomplete: `Payment` carries
 * 29 properties against roughly 80 on the wire, and `point_of_interaction` is absent
 * entirely, so the whole Pix QR payload is missing. We hand-write only the diff, and
 * every entry cites where its shape came from.
 */
export interface OverlayEntry {
  schema: string;
  note: string;
  source: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
}

/** Divergences that are not schema-shaped and cannot be expressed as an overlay. */
export interface Divergence {
  area: string;
  summary: string;
  detail: string;
  source: string;
}

const dateTime: JsonSchema = { type: ['string', 'null'], format: 'date-time' };

const transactionData: JsonSchema = {
  type: 'object',
  properties: {
    qr_code: { type: 'string' },
    qr_code_base64: { type: 'string' },
    ticket_url: { type: 'string' },
    transaction_id: { type: ['string', 'null'] },
    bank_transfer_id: { type: ['integer', 'null'] },
    financial_institution: { type: ['integer', 'null'] },
    bank_info: { type: 'object' },
  },
};

export const OVERLAY: readonly OverlayEntry[] = [
  {
    schema: 'Payment',
    note: 'point_of_interaction and barcode are absent from spec3.json; without it there is no Pix QR code on the wire. Shape taken from the Pix guide sample and sdk-nodejs PointOfInteraction.',
    source:
      'https://www.mercadopago.com.br/developers/en/docs/checkout-api-payments/integration-configuration/integrate-pix',
    properties: {
      live_mode: { type: 'boolean' },
      collector_id: { type: 'integer' },
      sponsor_id: { type: ['integer', 'null'] },
      authorization_code: { type: ['string', 'null'] },
      call_for_authorize_id: { type: ['string', 'null'] },
      money_release_status: { type: ['string', 'null'] },
      net_amount: { type: 'number' },
      taxes_amount: { type: 'number' },
      shipping_amount: { type: 'number' },
      counter_currency: { type: ['string', 'null'] },
      differential_pricing_id: { type: ['integer', 'null'] },
      deduction_schema: { type: ['string', 'null'] },
      pos_id: { type: ['string', 'null'] },
      store_id: { type: ['string', 'null'] },
      integrator_id: { type: ['string', 'null'] },
      platform_id: { type: ['string', 'null'] },
      corporation_id: { type: ['string', 'null'] },
      merchant_account_id: { type: ['string', 'null'] },
      merchant_number: { type: ['string', 'null'] },
      callback_url: { type: ['string', 'null'] },
      payment_method_option_id: { type: ['string', 'null'] },
      date_of_expiration: dateTime,
      order: {
        type: 'object',
        properties: { id: { type: 'string' }, type: { type: 'string' } },
      },
      payment_method: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          issuer_id: { type: ['string', 'null'] },
        },
      },
      point_of_interaction: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          sub_type: { type: ['string', 'null'] },
          application_data: {
            type: 'object',
            properties: { name: { type: ['string', 'null'] }, version: { type: ['string', 'null'] } },
          },
          transaction_data: transactionData,
        },
      },
      fee_details: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            amount: { type: 'number' },
            fee_payer: { type: 'string' },
          },
        },
      },
      charges_details: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string' },
            amounts: {
              type: 'object',
              properties: { original: { type: 'number' }, refunded: { type: 'number' } },
            },
          },
        },
      },
      refunds: { type: 'array', items: { $ref: '#/components/schemas/Refund' } },
      transaction_details: {
        type: 'object',
        properties: {
          net_received_amount: { type: 'number' },
          total_paid_amount: { type: 'number' },
          overpaid_amount: { type: 'number' },
          external_resource_url: { type: ['string', 'null'] },
          installment_amount: { type: 'number' },
          financial_institution: { type: ['string', 'null'] },
          payment_method_reference_id: { type: ['string', 'null'] },
          payable_deferral_period: { type: ['string', 'null'] },
          acquirer_reference: { type: ['string', 'null'] },
          transaction_id: { type: ['string', 'null'] },
          bank_transfer_id: { type: ['integer', 'null'] },
          digitable_line: { type: 'string' },
        },
      },
      barcode: {
        type: 'object',
        properties: { type: { type: ['string', 'null'] }, content: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } },
      },
    },
  },
  {
    schema: 'Refund',
    note: 'The spec enumerates only approved, in_process and rejected. The API also reports cancelled refunds, and returns nullable reason and unique_sequence_number.',
    source: 'https://github.com/mercadopago/sdk-nodejs — clients/paymentRefund/commonTypes.ts',
    properties: {
      status: { type: 'string', enum: ['approved', 'in_process', 'rejected', 'cancelled'] },
      reason: { type: ['string', 'null'] },
      unique_sequence_number: { type: ['string', 'null'] },
      refund_mode: { type: ['string', 'null'] },
      amount_refunded_to_payer: { type: ['number', 'null'] },
      adjustment_amount: { type: 'number' },
      metadata: { type: 'object' },
    },
  },
  {
    schema: 'PaymentRequest',
    note: 'The spec marks only transaction_amount and payer as required, and omits fields the API accepts for Pix and 3DS.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/payments/_payments/post',
    properties: {
      payment_method_id: { type: 'string' },
      three_ds_mode: { type: 'string', enum: ['not_supported', 'optional', 'mandatory'] },
      point_of_interaction: {
        type: 'object',
        properties: { type: { type: 'string' } },
      },
    },
  },
  {
    schema: 'Store',
    note: 'The spec models Store as allOf(StoreRequest, {id, date_created, date_last_updated}); the type emitter does not flatten allOf, so the response came out as `unknown`. The flattened shape is spelled out here, plus `user_id` (the collector that owns the store) and the `reference` the API returns inside `location`. `business_hours` is left open because the spec types only `monday`.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/stores/_users_user_id_stores/post',
    required: ['id', 'name'],
    properties: {
      id: { type: 'string' },
      user_id: { type: 'integer' },
      name: { type: 'string' },
      external_id: { type: ['string', 'null'] },
      business_hours: { type: 'object' },
      location: {
        type: 'object',
        properties: {
          street_number: { type: ['string', 'null'] },
          street_name: { type: ['string', 'null'] },
          city_name: { type: ['string', 'null'] },
          state_name: { type: ['string', 'null'] },
          zip_code: { type: ['string', 'null'] },
          reference: { type: ['string', 'null'] },
          latitude: { type: ['number', 'null'] },
          longitude: { type: ['number', 'null'] },
        },
      },
      date_created: dateTime,
      date_last_updated: dateTime,
    },
  },
  {
    schema: 'POS',
    note: 'Same allOf gap as Store. The flattened shape also carries what the spec omits: the numeric `id` the API returns, the owning `user_id`, `status`, and the `qr` object with the image and the printable templates, which is the whole point of a point of sale.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/pos/_pos/post',
    required: ['id', 'name', 'store_id'],
    properties: {
      id: { type: 'integer' },
      user_id: { type: 'integer' },
      name: { type: 'string' },
      store_id: { type: 'string' },
      external_id: { type: ['string', 'null'] },
      external_store_id: { type: ['string', 'null'] },
      category: { type: 'integer' },
      fixed_amount: { type: 'boolean' },
      url: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['active', 'inactive'] },
      qr: {
        type: 'object',
        properties: {
          image: { type: 'string' },
          template_document: { type: 'string' },
          template_image: { type: 'string' },
        },
      },
      qr_code: { type: 'string' },
      date_created: dateTime,
      date_last_updated: dateTime,
    },
  },
];

export const DIVERGENCES: readonly Divergence[] = [
  {
    area: 'Payments',
    summary: 'Payment `id` is a number on the resource and a string in search results',
    detail:
      'GET /v1/payments/{id} returns `id` as an integer while /v1/payments/search returns it as a string. payground reproduces the inconsistency rather than normalising it, because integrators branch on it.',
    source: 'https://github.com/mercadopago/sdk-nodejs — clients/payment/search/types.ts',
  },
  {
    area: 'Webhooks',
    summary: '`data.id` is lowercased before entering the signature manifest',
    detail:
      'The webhook documentation says to lowercase `data.id` before building the manifest; the official Node validator does not lowercase. payground lowercases, which keeps signatures valid under both readings for numeric ids.',
    source:
      'https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks',
  },
  {
    area: 'Errors',
    summary: '`cause[].code` is typed as an integer in the spec but observed as both',
    detail:
      'spec3.json types ErrorCause.code as integer. Documentation samples and real responses use string codes as well. payground emits the type the real endpoint is known to emit, per endpoint.',
    source: 'https://github.com/mercadopago/openapi — components.schemas.ErrorCause',
  },
  {
    area: 'Pix',
    summary: 'The documented BR Code sample is not a valid EMV payload',
    detail:
      'In the Pix guide sample, tag 26 declares length 60 for 64 characters of content and `0117john@yourdomain.com` declares length 17 for a 19 character value. payground generates a spec-correct EMV MPM payload instead of copying the sample, and proves it with a third-party decoder in the e2e suite.',
    source:
      'https://www.mercadopago.com.br/developers/en/docs/checkout-api-payments/integration-configuration/integrate-pix',
  },
  {
    area: 'Merchant orders',
    summary: 'Merchant orders are read-only and derived from preferences',
    detail:
      'The real API exposes POST /merchant_orders and PUT /merchant_orders/{id}. payground creates a merchant order when a Checkout Pro preference first receives a payment and keeps its totals and order_status in step, but does not accept direct creation or update.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/merchant_orders/_merchant_orders/post',
  },
  {
    area: 'Node SDK',
    summary: 'Per-call requestOptions leak into the shared client configuration',
    detail:
      'Payment.create and friends assign `this.config.options = {...this.config.options, ...requestOptions}`, so a per-call X-Idempotency-Key is pinned onto the client and reused by every later request. Against the real API this silently replays a stale response; against payground it surfaces as a 409. Use a fresh client per idempotency key, or omit requestOptions.',
    source: 'https://github.com/mercadopago/sdk-nodejs — dist/clients/payment/index.js',
  },
  {
    area: 'Fixtures',
    summary: 'Upstream fixtures use the Orders API status vocabulary for a Payments API resource',
    detail:
      'fixtures3.yaml `payment_pix` uses `status_detail: waiting_transfer`, while the Payments API documents `pending_waiting_transfer`. payground follows the documentation.',
    source: 'https://github.com/mercadopago/openapi — fixtures3.yaml',
  },
  {
    area: 'Stores and points of sale',
    summary: 'A store that still owns a point of sale is not deleted',
    detail:
      'The reference documents no outcome for DELETE /users/{user_id}/stores/{id} when points of sale still hang off the store. payground refuses with 400 rather than cascading, because silently destroying every POS — and its QR codes — on a delete is the more damaging of the two guesses. Delete the points of sale first.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/stores/_users_user_id_stores_id/delete',
  },
  {
    area: 'Stores and points of sale',
    summary: 'A duplicate external_id is rejected with 400, not 409',
    detail:
      'external_id is unique per collector for both stores and points of sale. The POS reference describes a 409 `point_of_sale_exists` for the duplicate, but the vendored spec3.json declares only 201, 400 and 401 for createPOS. payground answers 400 for both resources, so the two stay consistent with each other and with the vendored contract.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/pos/_pos/post',
  },
  {
    area: 'Stores and points of sale',
    summary: 'PUT /pos/{id} merges the fields it is given',
    detail:
      'The spec declares POSRequest — with name and store_id required — as the body of updatePOS. payground treats the update as a merge, so `{"status":"inactive"}` alone is enough to disable a point of sale and an omitted field keeps its value. A full body behaves identically, so integrations written against the real API keep working.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/pos/_pos_id/put',
  },
  {
    area: 'Stores and points of sale',
    summary: 'The printable POS QR document is HTML, not PDF',
    detail:
      'On the real API `qr.template_document` is a PDF. payground renders no PDFs, so it serves the same printable page as HTML at the URL it advertises, and `qr.image` and `qr.template_image` as real PNGs of the QR. Every URL a POS advertises is served by payground rather than pointing at mercadopago.com.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/pos/_pos/post',
  },
];
