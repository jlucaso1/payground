import { describe, expect, test } from 'bun:test';
import { emitRoutes } from './emit-routes.ts';
import type { OpenApiDocument } from './schema.ts';

const doc: OpenApiDocument = {
  paths: {
    '/v1/payments/{id}': {
      get: {
        operationId: 'getPayment',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: { '200': {}, '404': {} },
      },
      put: {
        operationId: 'updatePayment',
        deprecated: true,
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentUpdateRequest' } } } },
        responses: { '200': {} },
      },
    },
  },
  components: { schemas: {} },
};

describe('route emission', () => {
  const src = emitRoutes(doc);

  test('translates path templates to Bun patterns', () => {
    expect(src).toContain('path: "/v1/payments/{id}"');
    expect(src).toContain('pattern: "/v1/payments/:id"');
  });

  test('carries method, security, params and body schema', () => {
    expect(src).toContain('method: "GET"');
    expect(src).toContain('security: ["bearerAuth"]');
    expect(src).toContain('{ name: "id", in: "path", required: true }');
    expect(src).toContain('requestSchema: "PaymentUpdateRequest"');
  });

  test('preserves the deprecated flag and response statuses', () => {
    expect(src).toContain('deprecated: true');
    expect(src).toContain('statuses: ["200", "404"]');
  });
});
