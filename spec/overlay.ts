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
    area: 'Point',
    summary: 'A payment intent carries an uppercase `state`, not the spec\'s lowercase `status`',
    detail:
      'spec3.json inlines a simplified Point schema with `status: open|on_terminal|processing|processed|...`. The real API and the official Node SDK both use `state` with `OPEN`, `ON_TERMINAL`, `PROCESSING`, `FINISHED`, `CANCELED` and `ERROR`, and put the resulting payment id on `payment.id`. payground follows the SDK. Refund intents share the same machine but render it as a lowercase `status`, so their terminal values are `finished` and `canceled` rather than the spec\'s `processed` and `cancelled`. Both views also carry `error` with the reason a `finish` failed.',
    source: 'https://github.com/mercadopago/sdk-nodejs — dist/clients/point/commonTypes.d.ts',
  },
  {
    area: 'Node SDK',
    summary: 'The Point `Device` type describes a payment-intent event, not a device',
    detail:
      '`GetDevicesResponse.devices` is typed as `{ payment_intent_id, status, created_on }`, while the endpoint returns `{ id, pos_id, store_id, external_pos_id, operating_mode }`. payground returns the real shape, so TypeScript callers must cast until the SDK types are fixed.',
    source: 'https://github.com/mercadopago/sdk-nodejs — dist/clients/point/commonTypes.d.ts',
  },
  {
    area: 'Point',
    summary: 'Devices are seeded, and a device holds one intent at a time',
    detail:
      'There is no API to register a card reader, so each sandbox is seeded with three PAX_A910__SMARTPOS devices on first read. A reader can only run one intent, so creating a second one while an OPEN, ON_TERMINAL or PROCESSING intent exists is a 409. A FINISHED intent creates a real approved payment from the documented approving test card, which is what makes it visible on /v1/payments. Transitions are driven through the control API (POST /_payground/sandboxes/{id}/point/intents/{id}/actions) rather than by elapsed time, so tests never sleep.',
    source:
      'https://www.mercadopago.com.br/developers/en/docs/mp-point/integration-configuration/integration-devices',
  },
  {
    area: 'Terminals',
    summary: '/terminals/v1 wraps its payload in `data`, which spec3.json omits',
    detail:
      'The Terminals API returns `{ "data": { "terminals": [...] }, "paging": {...} }` for the list and the setup call, while spec3.json inlines a flat `{ "terminals": [...] }`. payground emits the real envelope. Terminal actions accept the spec\'s `type` and the guide\'s `action` interchangeably and always echo both.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/terminals/_terminals_v1_list/get',
  },
  {
    area: 'Fixtures',
    summary: 'Upstream fixtures use the Orders API status vocabulary for a Payments API resource',
    detail:
      'fixtures3.yaml `payment_pix` uses `status_detail: waiting_transfer`, while the Payments API documents `pending_waiting_transfer`. payground follows the documentation.',
    source: 'https://github.com/mercadopago/openapi — fixtures3.yaml',
  },
];
