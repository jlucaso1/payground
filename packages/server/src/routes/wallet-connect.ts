import {
  authorizeAgreement,
  authorizePage,
  createAgreement,
  createDiscount,
  createPayerToken,
  deleteAgreement,
  getAgreement,
  validateCoupon,
} from '@payground/mercadopago/api/wallet-connect.ts';
import { notFound } from '@payground/mercadopago/errors.ts';
import { contextFor, endpoint, fromResult } from '../http/handler.ts';
import type { RouteModule } from './module.ts';

const payerToken = (request: Request): string | null => request.headers.get('x-payer-token');

/** Wallet Connect agreements, payer tokens, discounts and coupons. */
export const walletConnect: RouteModule = {
  name: 'wallet-connect',
  operations: [
    'createWalletAgreement',
    'getWalletAgreement',
    'deleteWalletAgreement',
    'createWalletPayerToken',
    'createWalletDiscount',
    'validateWalletCoupon',
  ],
  pending: [],
  routes: ({ runtime, storage, param }) => {
    /**
     * The hosted approval page stands in for the Mercado Pago wallet redirect. The payer
     * carries no credentials, so the owning sandbox is the one holding the agreement.
     */
    const hosted = async (request: Request, agreementId: string): Promise<Response> => {
      const sandbox = storage.sandboxes
        .list()
        .find((candidate) => storage.forSandbox(candidate.id).documents.get('wallet_agreement', agreementId) !== null);
      if (sandbox === undefined) {
        return Response.json(notFound('Agreement not found'), { status: 404 });
      }
      const service = contextFor(runtime, sandbox);
      const html = (rendered: { status: number; html: string }): Response =>
        new Response(rendered.html, {
          status: rendered.status,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });

      if (request.method === 'GET') {
        const rendered = authorizePage(service, agreementId);
        return rendered.ok ? html(rendered.value) : Response.json(rendered.error, { status: rendered.error.status });
      }

      const form = new URLSearchParams(await request.text());
      const submitted = authorizeAgreement(service, agreementId, form);
      if (!submitted.ok) return Response.json(submitted.error, { status: submitted.error.status });
      return submitted.value.redirect === null
        ? html(submitted.value)
        : Response.redirect(submitted.value.redirect, 303);
    };

    return {
      '/v2/wallet_connect/agreements': {
        POST: endpoint(runtime, ({ service, body }) => fromResult(createAgreement(service, body))),
      },
      '/v2/wallet_connect/agreements/:agreement_id': {
        GET: endpoint(runtime, ({ service, request }) =>
          fromResult(getAgreement(service, param(request, 'agreement_id'))),
        ),
        DELETE: endpoint(runtime, ({ service, request }) =>
          fromResult(deleteAgreement(service, param(request, 'agreement_id'))),
        ),
      },
      '/v2/wallet_connect/agreements/:agreement_id/payer_token': {
        POST: endpoint(runtime, ({ service, request, body }) =>
          fromResult(createPayerToken(service, param(request, 'agreement_id'), body)),
        ),
      },
      '/v2/wallet_connect/discounts': {
        POST: endpoint(runtime, ({ service, request, body }) =>
          fromResult(createDiscount(service, payerToken(request), body)),
        ),
      },
      '/v2/wallet_connect/coupons': {
        POST: endpoint(runtime, ({ service, request, body }) =>
          fromResult(validateCoupon(service, payerToken(request), body)),
        ),
      },
      '/wallet_connect/authorize/:agreement_id': {
        GET: (request: Request) => hosted(request, param(request, 'agreement_id')),
        POST: (request: Request) => hosted(request, param(request, 'agreement_id')),
      },
    };
  },
};
