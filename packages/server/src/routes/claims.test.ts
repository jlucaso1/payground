import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MAX_ATTACHMENT_BYTES } from '@payground/mercadopago/api/claims.ts';
import type { Claim, ClaimEvidence, ClaimHistoryEntry, ClaimMessage, MediationResolution } from '@payground/mercadopago/generated/types.ts';
import { TEST_ACCESS_TOKEN, TEST_ADMIN_TOKEN, startTestServer } from '../testing.ts';

const server = startTestServer();
afterAll(() => server.stop());

const CLAIMS = '/post-purchase/v1/claims';

const upload = async (
  path: string,
  parts: { name: string; content: string; fileName?: string; type?: string }[],
  extra: Record<string, string> = {},
): Promise<Response> => {
  const form = new FormData();
  for (const part of parts) {
    if (part.fileName === undefined) form.append(part.name, part.content);
    else form.append(part.name, new File([part.content], part.fileName, { type: part.type ?? 'application/octet-stream' }));
  }
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return server.raw(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    body: form,
  });
};

async function approvedPayment(): Promise<number> {
  const token = await server.api('POST', '/v1/card_tokens', {
    body: {
      card_number: '4235647728025682',
      expiration_month: 11,
      expiration_year: 2030,
      security_code: '123',
      cardholder: { name: 'APRO', identification: { type: 'CPF', number: '12345678909' } },
    },
  });
  const payment = await server.api('POST', '/v1/payments', {
    body: {
      transaction_amount: 100.5,
      token: token.body.id,
      installments: 1,
      payer: { email: 'payer@example.com' },
    },
  });
  expect(payment.body.status).toBe('approved');
  return payment.body.id as number;
}

const openClaim = async (paymentId: number, reasonId = 'PNR0001') =>
  server.control('POST', `/_payground/sandboxes/${server.sandboxId}/claims`, {
    payment_id: paymentId,
    reason_id: reasonId,
  });

describe('the claims surface', () => {
  let paymentId = 0;
  let claimId = '';

  beforeAll(async () => {
    paymentId = await approvedPayment();
    const created = await openClaim(paymentId);
    expect(created.status).toBe(201);
    claimId = String((created.body as Claim).id);
  });

  test('an unauthenticated call is refused', async () => {
    const anonymous = await server.api('GET', `${CLAIMS}/search`, { token: null });
    expect(anonymous.status).toBe(401);
  });

  test('the claim is readable, searchable and has a history', async () => {
    const read = await server.api('GET', `${CLAIMS}/${claimId}`);
    expect(read.status).toBe(200);
    expect((read.body as Claim).resource_id).toBe(paymentId);
    expect((read.body as Claim).stage).toBe('claim');

    const search = await server.api('GET', `${CLAIMS}/search?status=opened`);
    expect(search.status).toBe(200);
    expect((search.body as { results: Claim[] }).results.map((claim) => String(claim.id))).toContain(claimId);

    const history = await server.api('GET', `${CLAIMS}/${claimId}/status_history`);
    expect((history.body as ClaimHistoryEntry[]).map((entry) => entry.stage)).toEqual(['claim']);

    expect((await server.api('GET', `${CLAIMS}/999`)).status).toBe(404);
  });

  test('the reason catalogue is served', async () => {
    const reason = await server.api('GET', `${CLAIMS}/reasons/PNR0001`);
    expect(reason.status).toBe(200);
    expect(reason.body.group).toBe('shipping');
    expect((await server.api('GET', `${CLAIMS}/reasons/NOPE`)).status).toBe(404);
  });

  test('messages are written and read back in order', async () => {
    const sent = await server.api('POST', `${CLAIMS}/${claimId}/actions/send-message`, {
      body: { message: 'the parcel left our warehouse' },
    });
    expect(sent.status).toBe(201);
    expect((sent.body as ClaimMessage).sender_role).toBe('respondent');

    const refused = await server.api('POST', `${CLAIMS}/${claimId}/actions/send-message`, { body: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('bad_request');

    const thread = await server.api('GET', `${CLAIMS}/${claimId}/messages`);
    expect((thread.body as ClaimMessage[])).toHaveLength(1);
  });

  test('an attachment round-trips as multipart in and bytes out', async () => {
    const attached = await upload(`${CLAIMS}/${claimId}/attachments`, [
      { name: 'file', content: 'invoice-bytes', fileName: 'invoice.pdf', type: 'application/pdf' },
    ]);
    expect(attached.status).toBe(201);
    const meta = (await attached.json()) as ClaimEvidence;
    expect(meta.file_name).toBe('invoice.pdf');
    expect(meta.content_type).toBe('application/pdf');
    // The documented response keys the file by file_id.
    expect(meta.file_id).toBe(meta.id ?? '');

    const described = await server.api('GET', `${CLAIMS}/${claimId}/attachments/invoice.pdf`);
    expect(described.status).toBe(200);
    expect((described.body as ClaimEvidence).size).toBe(13);

    const download = await server.raw(`${CLAIMS}/${claimId}/attachments/invoice.pdf/download`, {
      headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toBe(
      'attachment; filename="invoice.pdf"; filename*=UTF-8\'\'invoice.pdf',
    );
    expect(await download.text()).toBe('invoice-bytes');

    const missing = await server.raw(`${CLAIMS}/${claimId}/attachments/ghost.pdf/download`, {
      headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}` },
    });
    expect(missing.status).toBe(404);
  });

  test('a hostile filename can neither escape the claim nor inject a header', async () => {
    const hostile = await upload(`${CLAIMS}/${claimId}/attachments`, [
      {
        name: 'file',
        content: 'pwned',
        fileName: '../../../etc/pa"sswd\r\nX-Injected: yes',
        type: 'text/plain',
      },
    ]);
    expect(hostile.status).toBe(201);
    const meta = (await hostile.json()) as ClaimEvidence;
    // The multipart serializer percent-encodes the quote and the CRLF; the sanitizer then
    // flattens whatever survives, so no separator or header byte reaches the stored name.
    expect(meta.file_name).toBe('pa_22sswd_0D_0AX-Injected__yes');

    const download = await server.raw(
      `${CLAIMS}/${claimId}/attachments/${encodeURIComponent(meta.file_name ?? '')}/download`,
      { headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}` } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('x-injected')).toBeNull();
    const disposition = download.headers.get('content-disposition') ?? '';
    expect(disposition).toContain(`filename="${meta.file_name ?? ''}"`);
    expect(disposition).not.toContain('\r');
    // The traversal segments never reach the stored name.
    expect(disposition).not.toContain('..');
  });

  test('shipping evidence takes the spec JSON body and a file alike', async () => {
    const posted = await server.api('POST', `${CLAIMS}/${claimId}/actions/evidences`, {
      body: { type: 'tracking_code', value: 'BR123456789' },
    });
    expect(posted.status).toBe(201);
    expect((posted.body as ClaimEvidence).value).toBe('BR123456789');
    expect((posted.body as ClaimEvidence).file_name).toBeNull();

    const rejected = await server.api('POST', `${CLAIMS}/${claimId}/actions/evidences`, {
      body: { type: 'photo', value: 'x' },
    });
    expect(rejected.status).toBe(400);

    const sent = await upload(
      `${CLAIMS}/${claimId}/actions/evidences`,
      [{ name: 'file', content: 'label', fileName: 'label.png', type: 'image/png' }],
      { type: 'proof_of_delivery', description: 'courier scan' },
    );
    expect(sent.status).toBe(201);

    const listed = await server.api('GET', `${CLAIMS}/${claimId}/evidences`);
    expect((listed.body as ClaimEvidence[]).map((entry) => entry.type)).toEqual([
      'tracking_code',
      'proof_of_delivery',
    ]);
    expect((listed.body as ClaimEvidence[])[1]?.file_name).toBe('label.png');
  });

  test('a body that is not multipart is refused', async () => {
    const wrong = await server.raw(`${CLAIMS}/${claimId}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_ACCESS_TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe('bad_request');
  });

  test('an oversized upload is rejected on the declared length', async () => {
    const oversized = await server.raw(`${CLAIMS}/${claimId}/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        'content-type': 'multipart/form-data; boundary=----x',
      },
      body: new Uint8Array(MAX_ATTACHMENT_BYTES + 128 * 1_024),
    });
    expect(oversized.status).toBe(400);
    expect(((await oversized.json()) as { cause: { code: number }[] }).cause[0]?.code).toBe(4004);
  });

  test('an oversized chunked upload is cut off by the reader', async () => {
    const chunk = new Uint8Array(1_024 * 1_024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent <= MAX_ATTACHMENT_BYTES + 128 * 1_024; sent += chunk.byteLength) controller.enqueue(chunk);
        controller.close();
      },
    });
    const oversized = await server.raw(`${CLAIMS}/${claimId}/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        'content-type': 'multipart/form-data; boundary=----x',
      },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(oversized.status).toBe(400);
    expect(((await oversized.json()) as { cause: { code: number }[] }).cause[0]?.code).toBe(4004);
  });

  test('mediation escalates the claim and offers expected resolutions', async () => {
    expect((await server.api('GET', `${CLAIMS}/${claimId}/expected-resolutions`)).body).toEqual([]);

    const escalated = await server.api('POST', `${CLAIMS}/${claimId}/actions/open-dispute`);
    expect(escalated.status).toBe(200);
    expect((escalated.body as Claim).stage).toBe('dispute');
    expect((await server.api('GET', `/v1/payments/${paymentId}`)).body.status).toBe('in_mediation');

    const options = await server.api('GET', `${CLAIMS}/${claimId}/expected-resolutions`);
    expect((options.body as MediationResolution[]).map((option) => option.id)).toEqual([
      'refund_total',
      'partial_refund',
      'return_product',
    ]);

    // Escalating a claim already in dispute is refused by the state machine.
    expect((await server.api('POST', `${CLAIMS}/${claimId}/actions/open-dispute`)).status).toBe(422);
  });

  test('resolving for the buyer refunds the payment for real', async () => {
    const resolved = await server.control(
      'POST',
      `/_payground/sandboxes/${server.sandboxId}/claims/${claimId}/resolve`,
      { outcome: 'complainant' },
    );
    expect(resolved.status).toBe(200);
    expect((resolved.body as Claim).status).toBe('closed');
    expect((resolved.body as Claim).resolution?.type).toBe('refund');

    const payment = await server.api('GET', `/v1/payments/${paymentId}`);
    expect(payment.body.status).toBe('refunded');
    expect(payment.body.transaction_amount_refunded).toBe(100.5);

    const refunds = await server.api('GET', `/v1/payments/${paymentId}/refunds`);
    expect((refunds.body as unknown[]).length).toBe(1);

    // The whole thread is closed to new traffic afterwards.
    const late = await server.api('POST', `${CLAIMS}/${claimId}/actions/send-message`, { body: { message: 'hi' } });
    expect(late.status).toBe(422);
    expect(late.body.cause[0].description).toBe('claim_closed');
  });

  test('an injected outage reaches the upload routes as well', async () => {
    await server.control('PUT', `/_payground/sandboxes/${server.sandboxId}/faults`, {
      latencyMs: 0,
      errorRate: 0,
      unavailable: true,
      duplicateWebhooks: false,
      webhookFailureRate: 0,
    });
    const blocked = await upload(`${CLAIMS}/${claimId}/attachments`, [
      { name: 'file', content: 'x', fileName: 'x.png', type: 'image/png' },
    ]);
    expect(blocked.status).toBe(503);
    await server.control('PUT', `/_payground/sandboxes/${server.sandboxId}/faults`, {
      latencyMs: 0,
      errorRate: 0,
      unavailable: false,
      duplicateWebhooks: false,
      webhookFailureRate: 0,
    });
  });

  test('opening a claim needs the admin token', async () => {
    const denied = await server.control('POST', `/_payground/sandboxes/${server.sandboxId}/claims`, {}, 'wrong');
    expect(denied.status).toBe(401);
    expect(TEST_ADMIN_TOKEN).not.toBe('wrong');
  });
});
