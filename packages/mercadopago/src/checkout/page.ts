import { type JsonObject, type Minor, type Result, err, isJsonObject, ok, toDecimal } from '@payground/core';
import { type ErrorBody, badRequest, notFound } from '../errors.ts';
import { readNumber, readString } from '../api/document.ts';
import { attachPayment, orderForPreference } from '../api/merchant-orders.ts';
import { SITE_ID, type PreferenceView, initPoint, loadPreference } from '../api/preferences.ts';
import { createCardToken } from '../api/card-tokens.ts';
import { createPayment } from '../api/payments.ts';
import { TEST_CARDHOLDERS, TEST_CARDS } from '../generated/tables.ts';
import type { ServiceContext } from '../api/context.ts';
import { escapeHtml } from './html.ts';

/** The documented Mastercard test card; the generated table is the single source. */
const TEST_CARD = TEST_CARDS[0];
const FALLBACK_EMAIL = 'test_user@testuser.com';

type Outcome = 'pix' | 'card_approved' | 'card_rejected' | 'pending';

interface Option {
  outcome: Outcome;
  paymentType: string;
  label: string;
}

/** The payment type each option produces, so `excluded_payment_types` can hide it. */
const OPTIONS: readonly Option[] = [
  { outcome: 'pix', paymentType: 'bank_transfer', label: 'Pay with Pix (stays pending until settled)' },
  { outcome: 'card_approved', paymentType: 'credit_card', label: 'Pay by card — approved' },
  { outcome: 'card_rejected', paymentType: 'credit_card', label: 'Pay by card — rejected' },
  { outcome: 'pending', paymentType: 'ticket', label: 'Pay by ticket (leave pending)' },
];

/**
 * Rejection reasons are chosen through the cardholder name, the same lever the real
 * sandbox uses. https://www.mercadopago.com.br/developers/en/docs/your-integrations/test/cards
 */
const REASONS: readonly { code: string; label: string }[] = TEST_CARDHOLDERS.filter(
  (holder) => holder.code !== 'APRO' && holder.code !== 'CONT' && holder.code !== 'TEST',
).map((holder) => ({ code: holder.code, label: holder.scenario }));

const isOutcome = (value: string): value is Outcome =>
  OPTIONS.some((option) => option.outcome === value);

const amount = (value: Minor, currency: string): string =>
  `${currency} ${toDecimal(value).toFixed(2)}`;

const available = (view: PreferenceView): readonly Option[] =>
  OPTIONS.filter((option) => !view.excludedTypes.includes(option.paymentType));

const STYLE = `
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1a1a1a}
main{max-width:36rem;margin:0 auto;padding:2rem 1rem}
h1{font-size:1.25rem;margin:0 0 .25rem}
.card{background:#fff;border-radius:.5rem;padding:1rem 1.25rem;margin-bottom:1rem;box-shadow:0 1px 2px rgba(0,0,0,.08)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.35rem 0;border-bottom:1px solid #eee;font-size:.9rem}
td.n,th.n{text-align:right}
.total{display:flex;justify-content:space-between;font-weight:600;padding-top:.6rem}
fieldset{border:0;padding:0;margin:0 0 1rem}
legend{font-weight:600;padding:0 0 .5rem}
label.row{display:block;padding:.2rem 0}
button{background:#009ee3;color:#fff;border:0;border-radius:.3rem;padding:.6rem 1.2rem;font-size:1rem;cursor:pointer}
.muted{color:#666;font-size:.85rem}
`;

const page = (title: string, body: string): string =>
  `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
  `<body><main>${body}</main></body></html>\n`;

function itemsTable(view: PreferenceView): string {
  const rows = view.items
    .map((item) => {
      const title = readString(item, 'title') ?? '';
      const quantity = readNumber(item, 'quantity') ?? 1;
      const price = readNumber(item, 'unit_price') ?? 0;
      return (
        `<tr><td>${escapeHtml(title)}</td><td class="n">${escapeHtml(String(quantity))}</td>` +
        `<td class="n">${escapeHtml(`${view.currency} ${price.toFixed(2)}`)}</td></tr>`
      );
    })
    .join('');

  const shipping =
    view.shippingMinor === 0
      ? ''
      : `<div class="total"><span>Shipping</span><span>${escapeHtml(amount(view.shippingMinor, view.currency))}</span></div>`;

  return (
    `<section class="card"><table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Price</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>${shipping}` +
    `<div class="total"><span>Total</span><span>${escapeHtml(amount(view.dueMinor, view.currency))}</span></div></section>`
  );
}

function outcomeForm(context: ServiceContext, view: PreferenceView): string {
  const options = available(view);
  if (options.length === 0) {
    return `<section class="card"><p>No payment method is available for this preference.</p></section>`;
  }

  const radios = options
    .map(
      (option, index) =>
        `<label class="row"><input type="radio" name="outcome" value="${escapeHtml(option.outcome)}"` +
        `${index === 0 ? ' checked' : ''}> ${escapeHtml(option.label)}</label>`,
    )
    .join('');

  const reasons = REASONS.map(
    (reason) => `<option value="${escapeHtml(reason.code)}">${escapeHtml(reason.label)}</option>`,
  ).join('');

  const email = view.payerEmail ?? FALLBACK_EMAIL;

  return (
    `<form class="card" method="post" action="${escapeHtml(initPoint(context.baseUrl, view.id))}">` +
    `<fieldset><legend>Choose the outcome</legend>${radios}</fieldset>` +
    `<fieldset><legend>Rejection reason (card only)</legend>` +
    `<select name="reason">${reasons}</select></fieldset>` +
    `<fieldset><legend>Payer email</legend>` +
    `<input type="email" name="payer_email" value="${escapeHtml(email)}"></fieldset>` +
    `<button type="submit">Continue</button></form>`
  );
}

const header = (view: PreferenceView): string =>
  `<h1>payground checkout</h1><p class="muted">Preference ${escapeHtml(view.id)}</p>`;

export function checkoutPage(
  context: ServiceContext,
  preferenceId: string,
): Result<{ status: number; html: string }, ErrorBody> {
  const view = loadPreference(context, preferenceId);
  if (view === null) return err(notFound('Preference not found'));

  if (view.expired) {
    return ok({
      status: 200,
      html: page(
        'Checkout expired',
        `${header(view)}<section class="card"><p>This preference is outside its validity window.</p></section>`,
      ),
    });
  }

  return ok({
    status: 200,
    html: page('payground checkout', `${header(view)}${itemsTable(view)}${outcomeForm(context, view)}`),
  });
}

/**
 * The operator picks an outcome, not a card, so the page tokenises a documented test
 * card itself and carries the choice in the cardholder name, which is the lever the real
 * sandbox uses. https://www.mercadopago.com.br/developers/en/docs/your-integrations/test/cards
 */
function mintCardToken(context: ServiceContext, holderName: string): Result<string, ErrorBody> {
  const now = context.clock.now();
  const token = createCardToken(context, {
    card_number: TEST_CARD.number,
    security_code: TEST_CARD.securityCode,
    expiration_month: Number(TEST_CARD.expiration.split('/')[0]),
    // Kept ahead of the clock so the sandbox never rejects its own card as expired.
    expiration_year: new Date(now).getUTCFullYear() + 5,
    cardholder: { name: holderName },
  });
  if (!token.ok) return token;
  const id = isJsonObject(token.value.body) ? readString(token.value.body, 'id') : null;
  return id === null ? err(badRequest('card tokenisation failed')) : ok(id);
}

function paymentBody(
  context: ServiceContext,
  view: PreferenceView,
  outcome: Outcome,
  reason: string,
  email: string,
): Result<JsonObject, ErrorBody> {
  const base: JsonObject = {
    transaction_amount: toDecimal(view.dueMinor),
    description: readString(view.items[0] ?? {}, 'title') ?? 'payground checkout',
    payer: { email },
    metadata: view.metadata,
    ...(view.externalReference === null ? {} : { external_reference: view.externalReference }),
    ...(view.notificationUrl === null ? {} : { notification_url: view.notificationUrl }),
  };

  if (outcome === 'pix') return ok({ ...base, payment_method_id: 'pix' });
  if (outcome === 'pending') return ok({ ...base, payment_method_id: 'bolbradesco' });

  const token = mintCardToken(context, outcome === 'card_approved' ? 'APRO' : reason);
  if (!token.ok) return token;
  // The token carries the brand, so payment_method_id is left to the payments module.
  return ok({ ...base, installments: 1, token: token.value });
}

/**
 * Checkout Pro appends these on the way back, and sends the literal string `null` for
 * values it has none for.
 * https://www.mercadopago.com.br/developers/en/docs/checkout-pro/checkout-customization/user-interface/redirection
 */
export function returnParams(input: {
  paymentId: number;
  status: string;
  paymentType: string;
  merchantOrderId: string | null;
  preferenceId: string;
  externalReference: string | null;
}): Record<string, string> {
  return {
    collection_id: String(input.paymentId),
    collection_status: input.status,
    payment_id: String(input.paymentId),
    status: input.status,
    external_reference: input.externalReference ?? 'null',
    payment_type: input.paymentType,
    merchant_order_id: input.merchantOrderId ?? 'null',
    preference_id: input.preferenceId,
    site_id: SITE_ID,
    processing_mode: 'aggregator',
    merchant_account_id: 'null',
  };
}

function backUrlFor(view: PreferenceView, status: string): string {
  if (status === 'approved') return view.backUrls.success;
  if (status === 'rejected' || status === 'cancelled') return view.backUrls.failure;
  return view.backUrls.pending;
}

function withParams(url: string, params: Record<string, string>): string | null {
  try {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return target.toString();
  } catch {
    return null;
  }
}

/** `auto_return: approved` only sends the payer back automatically for approved payments. */
const autoReturns = (view: PreferenceView, status: string): boolean =>
  view.autoReturn !== 'approved' || status === 'approved';

function resultPage(view: PreferenceView, status: string, paymentId: number, target: string | null, redirecting: boolean): string {
  const refresh =
    redirecting && target !== null
      ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}">`
      : '';
  const link =
    target === null
      ? '<p class="muted">This preference has no matching back_url.</p>'
      : `<p><a href="${escapeHtml(target)}">Return to the store</a></p>`;

  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">${refresh}` +
    `<title>Payment ${escapeHtml(status)}</title><style>${STYLE}</style></head><body><main>` +
    `<h1>Payment ${escapeHtml(status)}</h1>` +
    `<section class="card"><p>Payment ${escapeHtml(String(paymentId))} for preference ` +
    `${escapeHtml(view.id)}.</p>${link}</section></main></body></html>\n`
  );
}

export function checkoutSubmit(
  context: ServiceContext,
  preferenceId: string,
  form: URLSearchParams,
): Result<{ status: number; redirect: string | null; html: string }, ErrorBody> {
  const view = loadPreference(context, preferenceId);
  if (view === null) return err(notFound('Preference not found'));
  if (view.expired) {
    return err(badRequest('invalid parameters', [{ code: 2021, description: 'preference expired' }]));
  }

  const outcome = form.get('outcome') ?? '';
  if (!isOutcome(outcome)) {
    return err(badRequest('invalid parameters', [{ code: 2034, description: 'outcome invalid' }]));
  }
  if (!available(view).some((option) => option.outcome === outcome)) {
    return err(
      badRequest('invalid parameters', [{ code: 2022, description: 'outcome excluded by the preference' }]),
    );
  }

  const requested = form.get('reason') ?? 'OTHE';
  const reason = REASONS.some((entry) => entry.code === requested) ? requested : 'OTHE';
  const submitted = form.get('payer_email');
  const email =
    submitted !== null && submitted.includes('@') ? submitted : (view.payerEmail ?? FALLBACK_EMAIL);

  const request = paymentBody(context, view, outcome, reason, email);
  if (!request.ok) return request;

  const created = createPayment(context, request.value);
  if (!created.ok) return created;

  const body = created.value.body;
  if (!isJsonObject(body)) return err(badRequest('payment creation failed'));
  const paymentId = readNumber(body, 'id') ?? 0;
  const status = readString(body, 'status') ?? 'pending';
  const paymentType = readString(body, 'payment_type_id') ?? '';
  const transactionAmount = readNumber(body, 'transaction_amount') ?? 0;

  attachPayment(context, preferenceId, paymentId, status, transactionAmount);
  const order = orderForPreference(context, preferenceId);

  const backUrl = backUrlFor(view, status);
  const target =
    backUrl === ''
      ? null
      : withParams(
          backUrl,
          returnParams({
            paymentId,
            status,
            paymentType,
            merchantOrderId: order === null ? null : String(order.sequence),
            preferenceId,
            externalReference: view.externalReference,
          }),
        );

  const redirecting = target !== null && autoReturns(view, status);
  return ok({
    status: 200,
    redirect: redirecting ? target : null,
    html: resultPage(view, status, paymentId, target, redirecting),
  });
}
