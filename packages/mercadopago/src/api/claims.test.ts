import { describe, expect, test } from 'bun:test';
import { type Result, unwrap } from '@payground/core';
import type { ErrorBody } from '../errors.ts';
import type { Claim, ClaimEvidence, ClaimHistoryEntry, ClaimMessage, ClaimReason, MediationResolution } from '../generated/types.ts';
import { createCardToken } from './card-tokens.ts';
import {
  CLAIM_REASONS,
  CLAIM_TRANSITIONS,
  type ClaimRecord,
  MAX_ATTACHMENT_BYTES,
  applyClaim,
  attachClaimFile,
  claimAllowed,
  downloadClaimFile,
  getClaim,
  getClaimEvidence,
  getClaimFile,
  getClaimHistory,
  getClaimMediationResolutions,
  getClaimMessages,
  getClaimReasons,
  openClaim,
  requestClaimMediation,
  resolveClaim,
  sanitizeFileName,
  sanitizeMediaType,
  searchClaims,
  sendClaimMessage,
  uploadEvidenceFile,
  uploadShippingEvidence,
} from './claims.ts';
import type { Rendered, ServiceContext } from './context.ts';
import { cardPaymentBody, cardTokenBody, harness } from './fixture.ts';
import { createPayment, getPayment } from './payments.ts';

const failed = (result: Result<unknown, ErrorBody>): ErrorBody => {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
};

function approvedPayment(context: ServiceContext, cardholder = 'APRO'): number {
  const token = unwrap(createCardToken(context, cardTokenBody({ cardholder: { name: cardholder } })))
    .body as { id?: string };
  const payment = unwrap(createPayment(context, cardPaymentBody(token.id ?? ''))).body as { id?: number };
  return payment.id ?? 0;
}

function opened(context: ServiceContext, overrides: Record<string, unknown> = {}): Claim {
  const paymentId = approvedPayment(context);
  return unwrap(openClaim(context, { payment_id: paymentId, reason_id: 'PNR0001', ...overrides })).body as Claim;
}

const body = <T>(result: Result<Rendered, ErrorBody>): T => unwrap(result).body as T;

describe('the claim state machine', () => {
  const record = (state: ClaimRecord['state']): ClaimRecord => ({
    id: 1,
    state,
    type: 'claims',
    paymentId: 1,
    buyerId: 1,
    reasonId: 'PNR0001',
    createdAt: 0,
    updatedAt: 0,
    history: [],
    attachments: [],
    evidences: [],
    resolution: null,
  });

  test('only the listed commands are allowed', () => {
    expect(claimAllowed('opened', 'escalate')).toBe(true);
    expect(claimAllowed('opened', 'resolve')).toBe(false);
    expect(claimAllowed('dispute', 'resolve')).toBe(true);
    expect(claimAllowed('closed', 'resolve')).toBe(false);
    expect(CLAIM_TRANSITIONS.cancelled).toEqual([]);
  });

  test('an illegal transition is a typed error, not a throw', () => {
    const result = applyClaim(record('closed'), 'escalate', 10, 'buyer');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toEqual({ kind: 'invalid_transition', from: 'closed', command: 'escalate' });
  });

  test('a legal transition appends to the history', () => {
    const result = applyClaim(record('opened'), 'escalate', 10, 'buyer');
    expect(unwrap(result).state).toBe('dispute');
    expect(unwrap(result).history).toHaveLength(1);
    expect(unwrap(result).history[0]?.stage).toBe('dispute');
  });
});

describe('opening a claim', () => {
  test('a claim is opened against an existing payment', () => {
    const app = harness();
    const claim = opened(app.context);
    expect(claim.status).toBe('opened');
    expect(claim.stage).toBe('claim');
    expect(claim.reason_id).toBe('PNR0001');
    expect(claim.resource).toBe('payment');
    expect(claim.players?.map((player) => player.role)).toEqual(['complainant', 'respondent']);
    expect(claim.status_history).toHaveLength(1);
  });

  test('an unknown payment or reason is refused', () => {
    const app = harness();
    expect(failed(openClaim(app.context, { payment_id: 999 })).status).toBe(404);
    const paymentId = approvedPayment(app.context);
    expect(failed(openClaim(app.context, { payment_id: paymentId, reason_id: 'nope' })).status).toBe(400);
    expect(failed(openClaim(app.context, 'not an object')).status).toBe(400);
    expect(failed(openClaim(app.context, {})).status).toBe(400);
  });

  test('the claim reads back and appears in a search', () => {
    const app = harness();
    const claim = opened(app.context);
    expect(body<Claim>(getClaim(app.context, String(claim.id))).id).toBe(claim.id ?? 0);
    expect(failed(getClaim(app.context, '404')).status).toBe(404);

    const found = body<{ paging: { total: number }; results: Claim[] }>(
      searchClaims(app.context, new URLSearchParams({ status: 'opened' })),
    );
    expect(found.paging.total).toBe(1);
    expect(found.results[0]?.id).toBe(claim.id ?? 0);

    const none = body<{ paging: { total: number } }>(
      searchClaims(app.context, new URLSearchParams({ stage: 'dispute' })),
    );
    expect(none.paging.total).toBe(0);
    expect(failed(searchClaims(app.context, new URLSearchParams({ limit: '-1' }))).status).toBe(400);
    expect(failed(searchClaims(app.context, new URLSearchParams({ limit: '0' }))).status).toBe(400);
    // An over-large limit is clamped, and paging reports what was actually applied.
    const clamped = body<{ paging: { limit: number } }>(
      searchClaims(app.context, new URLSearchParams({ limit: '500' })),
    );
    expect(clamped.paging.limit).toBe(100);
  });
});

describe('reasons', () => {
  test('the catalogue is served by id', () => {
    const app = harness();
    expect(body<ClaimReason>(getClaimReasons(app.context, 'PDD0002')).description).toContain('damaged');
    expect(body<ClaimReason[]>(getClaimReasons(app.context, 'all'))).toHaveLength(CLAIM_REASONS.length);
    expect(failed(getClaimReasons(app.context, 'ZZZ')).status).toBe(404);
  });
});

describe('messages', () => {
  test('a thread carries roles, dates and attachments', () => {
    const app = harness();
    const claim = opened(app.context);
    const id = String(claim.id);

    const first = body<ClaimMessage>(sendClaimMessage(app.context, id, { message: 'we are looking into it' }));
    expect(first.sender_role).toBe('respondent');
    expect(first.receiver_role).toBe('complainant');
    expect(first.stage).toBe('claim');
    expect(first.date_created).toContain('T');

    app.clock.advance(1_000);
    const second = body<ClaimMessage>(
      sendClaimMessage(app.context, id, { message: 'still waiting', sender_role: 'complainant' }),
    );
    expect(second.sender_role).toBe('complainant');
    expect(second.from?.user_id).toBe(claim.players?.[0]?.user_id ?? -1);

    const thread = body<ClaimMessage[]>(getClaimMessages(app.context, id));
    expect(thread.map((message) => message.message)).toEqual(['we are looking into it', 'still waiting']);
  });

  test('an empty, oversized or unparseable message is refused', () => {
    const app = harness();
    const id = String(opened(app.context).id);
    expect(failed(sendClaimMessage(app.context, id, {})).status).toBe(400);
    expect(failed(sendClaimMessage(app.context, id, { message: '   ' })).status).toBe(400);
    expect(failed(sendClaimMessage(app.context, id, { message: 'x'.repeat(2_001) })).status).toBe(400);
    expect(failed(sendClaimMessage(app.context, id, { message: 'hi', attachments: ['ghost'] })).status).toBe(400);
  });

  test('a message can cite an attachment already on the claim', () => {
    const app = harness();
    const id = String(opened(app.context).id);
    const file = body<ClaimEvidence>(
      attachClaimFile(app.context, id, {
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode('%PDF-1.4'),
      }),
    );
    const message = body<ClaimMessage>(
      sendClaimMessage(app.context, id, { message: 'proof attached', attachments: [file.id ?? ''] }),
    );
    expect(message.attachments).toEqual([{ file_name: 'receipt.pdf', file_id: file.id ?? '' }]);
  });
});

describe('files', () => {
  const upload = (name: string, contentType = 'image/png', text = 'bytes') => ({
    fileName: name,
    contentType,
    bytes: new TextEncoder().encode(text),
  });

  test('an attachment round-trips through base64 storage', () => {
    const app = harness();
    const id = String(opened(app.context).id);
    const stored = body<ClaimEvidence>(attachClaimFile(app.context, id, upload('photo.png')));
    expect(stored.file_name).toBe('photo.png');
    expect(stored.content_type).toBe('image/png');
    expect(stored.size).toBe(5);

    expect(body<ClaimEvidence>(getClaimFile(app.context, id, 'photo.png')).id).toBe(stored.id ?? '');
    const download = unwrap(downloadClaimFile(app.context, id, 'photo.png'));
    expect(new TextDecoder().decode(download.bytes)).toBe('bytes');
    expect(download.contentType).toBe('image/png');
    expect(failed(downloadClaimFile(app.context, id, 'missing.png')).status).toBe(404);
  });

  test('a hostile file name cannot traverse a path or inject a header', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a"; rm -rf /\r\nX-Injected: 1')).toBe('__X-Injected__1');
    expect(sanitizeFileName('a"; drop\r\nX-Injected: 1')).toBe('a___drop__X-Injected__1');
    expect(sanitizeFileName('..')).toBeNull();
    expect(sanitizeFileName('/')).toBeNull();
    expect(sanitizeFileName('')).toBeNull();
    expect(sanitizeFileName('x'.repeat(500))).toHaveLength(120);

    const app = harness();
    const id = String(opened(app.context).id);
    const stored = body<ClaimEvidence>(attachClaimFile(app.context, id, upload('../../evil.png')));
    expect(stored.file_name).toBe('evil.png');
    expect(stored.file_name).not.toContain('/');
    expect(failed(attachClaimFile(app.context, id, upload('..'))).status).toBe(400);
  });

  test('a hostile media type falls back to octet-stream', () => {
    expect(sanitizeMediaType('image/png; charset=utf-8')).toBe('image/png');
    expect(sanitizeMediaType('text/html\r\nX-Injected: 1')).toBe('application/octet-stream');
    expect(sanitizeMediaType('')).toBe('application/octet-stream');

    const app = harness();
    const id = String(opened(app.context).id);
    const stored = body<ClaimEvidence>(attachClaimFile(app.context, id, upload('x.bin', 'nonsense')));
    expect(stored.content_type).toBe('application/octet-stream');
  });

  test('empty, duplicated and oversized files are refused', () => {
    const app = harness();
    const id = String(opened(app.context).id);
    expect(failed(attachClaimFile(app.context, id, { ...upload('a.png'), bytes: new Uint8Array() })).status).toBe(400);
    attachClaimFile(app.context, id, upload('a.png'));
    expect(failed(attachClaimFile(app.context, id, upload('a.png'))).status).toBe(400);
    for (const name of ['b.png', 'c.png', 'd.png', 'e.png']) attachClaimFile(app.context, id, upload(name));
    expect(failed(attachClaimFile(app.context, id, upload('f.png'))).status).toBe(400);
    expect(
      failed(
        attachClaimFile(app.context, id, {
          ...upload('big.png'),
          bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
        }),
      ).status,
    ).toBe(400);
  });

  test('shipping evidence is listed separately from message attachments', () => {
    const app = harness();
    const id = String(opened(app.context).id);
    attachClaimFile(app.context, id, upload('note.png'));
    const evidence = body<ClaimEvidence>(
      uploadEvidenceFile(app.context, id, upload('label.png'), 'tracking_code', 'BR123456789'),
    );
    expect(evidence.type).toBe('tracking_code');
    expect(evidence.description).toBe('BR123456789');

    const listed = body<ClaimEvidence[]>(getClaimEvidence(app.context, id));
    expect(listed.map((entry) => entry.file_name)).toEqual(['label.png']);
    expect(failed(downloadClaimFile(app.context, id, 'label.png')).status).toBe(404);
  });

  test('the spec JSON evidence body carries a value rather than a file', () => {
    const app = harness();
    const id = String(opened(app.context).id);
    const evidence = body<ClaimEvidence>(
      uploadShippingEvidence(app.context, id, { type: 'proof_of_delivery', value: 'BR999' }),
    );
    expect(evidence.type).toBe('proof_of_delivery');
    expect(evidence.value).toBe('BR999');
    expect(evidence.file_name).toBeNull();
    expect(evidence.size).toBeNull();
    // A value-only evidence has no bytes to download.
    expect(failed(downloadClaimFile(app.context, id, 'BR999')).status).toBe(404);

    expect(failed(uploadShippingEvidence(app.context, id, { type: 'photo', value: 'x' })).status).toBe(400);
    expect(failed(uploadShippingEvidence(app.context, id, { type: 'tracking_code' })).status).toBe(400);
    expect(failed(uploadShippingEvidence(app.context, id, 'nope')).status).toBe(400);
  });

  test('an attachment is addressable by the documented file_id', () => {
    const app = harness();
    const id = String(opened(app.context).id);
    const stored = body<ClaimEvidence>(attachClaimFile(app.context, id, upload('doc.png')));
    expect(stored.file_id).toBe(stored.id ?? '');
    expect(
      body<{ attachments?: { file_id?: string }[] }>(
        sendClaimMessage(app.context, id, { message: 'see attached', attachments: [stored.file_id ?? ''] }),
      ).attachments?.[0]?.file_id,
    ).toBe(stored.file_id ?? '');
  });
});

describe('mediation', () => {
  test('escalating puts the claim in dispute and the payment in mediation', () => {
    const app = harness();
    const claim = opened(app.context);
    const id = String(claim.id);

    const escalated = body<Claim>(requestClaimMediation(app.context, id));
    expect(escalated.stage).toBe('dispute');
    expect(escalated.status).toBe('opened');
    expect(body<{ status?: string }>(getPayment(app.context, String(claim.resource_id))).status).toBe('in_mediation');

    const history = body<ClaimHistoryEntry[]>(getClaimHistory(app.context, id));
    expect(history.map((entry) => entry.stage)).toEqual(['claim', 'dispute']);

    // Escalating twice is an illegal transition, not a silent no-op.
    expect(failed(requestClaimMediation(app.context, id)).status).toBe(422);
  });

  test('expected resolutions appear only while the claim is in dispute', () => {
    const app = harness();
    const id = String(opened(app.context).id);
    expect(body<MediationResolution[]>(getClaimMediationResolutions(app.context, id))).toEqual([]);

    requestClaimMediation(app.context, id);
    const options = body<MediationResolution[]>(getClaimMediationResolutions(app.context, id));
    expect(options.map((option) => option.id)).toEqual(['refund_total', 'partial_refund', 'return_product']);
    expect(options[0]?.amount).toBe(100.5);
    expect(options[1]?.amount).toBe(50.25);
  });

  test('a resolution for the buyer actually refunds the payment', () => {
    const app = harness();
    const claim = opened(app.context);
    const id = String(claim.id);
    const paymentId = String(claim.resource_id);

    requestClaimMediation(app.context, id);
    const resolved = body<Claim>(resolveClaim(app.context, id, 'complainant'));
    expect(resolved.status).toBe('closed');
    expect(resolved.stage).toBe('resolution');
    expect(resolved.resolution?.type).toBe('refund');
    expect(resolved.resolution?.benefited).toEqual(['complainant']);

    const payment = body<{ status?: string; transaction_amount_refunded?: number }>(
      getPayment(app.context, paymentId),
    );
    expect(payment.status).toBe('refunded');
    expect(payment.transaction_amount_refunded).toBe(100.5);
  });

  test('a resolution for the seller leaves the money alone', () => {
    const app = harness();
    const claim = opened(app.context);
    const id = String(claim.id);
    requestClaimMediation(app.context, id);
    expect(body<Claim>(resolveClaim(app.context, id, 'respondent')).resolution?.type).toBe('seller_favour');
    const payment = body<{ status?: string; transaction_amount_refunded?: number }>(
      getPayment(app.context, String(claim.resource_id)),
    );
    expect(payment.status).toBe('approved');
    expect(payment.transaction_amount_refunded).toBe(0);
  });

  test('a closed claim refuses more traffic', () => {
    const app = harness();
    const id = String(opened(app.context).id);
    requestClaimMediation(app.context, id);
    resolveClaim(app.context, id, 'complainant');

    expect(failed(resolveClaim(app.context, id, 'complainant')).status).toBe(422);
    const late = failed(sendClaimMessage(app.context, id, { message: 'hello' }));
    expect(late.status).toBe(422);
    expect(late.cause[0]?.description).toBe('claim_closed');
    expect(
      failed(
        attachClaimFile(app.context, id, {
          fileName: 'x.png',
          contentType: 'image/png',
          bytes: new Uint8Array([1]),
        }),
      ).status,
    ).toBe(422);
  });

  test('a payment that cannot enter mediation blocks the escalation', () => {
    const app = harness();
    const token = unwrap(createCardToken(app.context, cardTokenBody())).body as { id?: string };
    const pending = unwrap(createPayment(app.context, cardPaymentBody(token.id ?? '', { capture: false })))
      .body as { id?: number };
    const claim = unwrap(openClaim(app.context, { payment_id: pending.id, reason_id: 'PNR0001' })).body as Claim;
    expect(failed(requestClaimMediation(app.context, String(claim.id))).status).toBe(422);
    expect(body<Claim>(getClaim(app.context, String(claim.id))).stage).toBe('claim');
  });
});
