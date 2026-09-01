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
    schema: 'Claim',
    note: 'The spec omits the payment the claim was opened against, the parent claim, the site, the status history the /status_history endpoint returns, and the resolution recorded when a dispute ends.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/claims/get-claim/get',
    properties: {
      resource_id: { type: ['integer', 'null'] },
      parent_id: { type: ['integer', 'null'] },
      site_id: { type: 'string' },
      status_history: { type: 'array', items: { $ref: '#/components/schemas/ClaimHistoryEntry' } },
      resolution: {
        type: ['object', 'null'],
        properties: {
          type: { type: 'string', enum: ['refund', 'return', 'partial_refund', 'seller_favour'] },
          reason: { type: ['string', 'null'] },
          date_created: { type: 'string', format: 'date-time' },
          benefited: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    schema: 'ClaimMessage',
    note: 'The message list carries the claim it belongs to, the flat sender_role/receiver_role pair the notification payload uses, and the stage the message was written in; the spec only models the nested `from` object.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/claims/get-claim-messages/get',
    properties: {
      claim_id: { type: 'integer' },
      sender_role: { type: 'string', enum: ['complainant', 'respondent', 'mediator'] },
      receiver_role: { type: 'string', enum: ['complainant', 'respondent', 'mediator'] },
      stage: { type: 'string', enum: ['claim', 'dispute', 'resolution'] },
    },
  },
  {
    schema: 'ClaimEvidence',
    note: 'The attachment responses key a file by `file_id`, which ClaimEvidence lacks, and shipping evidence can be a plain `value` (a tracking code) rather than a file, so the file fields are nullable. The request enum also admits proof_of_delivery, which the resource enum omits.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/claims/upload-evidence/post',
    properties: {
      claim_id: { type: 'integer' },
      file_id: { type: 'string' },
      file_name: { type: ['string', 'null'] },
      content_type: { type: ['string', 'null'] },
      size: { type: ['integer', 'null'] },
      value: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      type: {
        type: 'string',
        enum: ['tracking_code', 'proof_of_delivery', 'photo', 'invoice', 'other'],
      },
    },
  },
  {
    schema: 'ClaimReason',
    note: 'A reason carries the group it belongs to and the flow that produced it; the spec keeps only id, description and type.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/claims/get-claim-reason/get',
    properties: {
      detail: { type: 'string' },
      group: { type: 'string' },
      flow: { type: 'string' },
    },
  },
  {
    schema: 'MediationResolution',
    note: 'Each expected resolution is addressable and scoped to a currency; the spec omits both, so two options of the same type are indistinguishable.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/claims/get-expected-resolutions/get',
    properties: {
      id: { type: 'string' },
      currency_id: { type: ['string', 'null'] },
      benefited: { type: 'string', enum: ['complainant', 'respondent'] },
    },
  },
];

export const DIVERGENCES: readonly Divergence[] = [
  {
    area: 'Claims',
    summary: 'Claims are opened and resolved from the control API, not the emulated one',
    detail:
      'The real API has no public endpoint that opens a claim or applies a mediation resolution — a buyer opens a claim from the Mercado Pago front end and Mercado Pago mediates it. payground exposes both under the control namespace (POST /_payground/sandboxes/{id}/claims and .../claims/{claim_id}/resolve) so a test or the dashboard can drive a sandbox through the post-purchase flow. Resolving for the complainant refunds the payment through the same domain command the Payments API uses, so the money is real.',
    source: 'https://www.mercadopago.com.br/developers/en/docs/post-purchase/claims/introduction',
  },
  {
    area: 'Claims',
    summary: 'Shipping evidence also accepts a file, and a message can declare its sender',
    detail:
      'POST /post-purchase/v1/claims/{claim_id}/actions/evidences takes the specified JSON body `{ type, value }`, and additionally accepts multipart/form-data with a `file` part so an evidence photo or invoice can be exercised end to end. POST .../actions/send-message infers the sender from the token, which is always the seller; payground accepts a non-spec `sender_role` so a test can write the buyer or mediator side of a thread it has no session for.',
    source: 'https://www.mercadopago.com.br/developers/en/reference/claims/upload-evidence/post',
  },
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
];
