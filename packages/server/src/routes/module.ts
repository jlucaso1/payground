import type { Storage } from '@payground/storage';
import type { AppRuntime } from '../http/handler.ts';

export type RouteTable = Record<string, unknown>;

export interface PendingOperation {
  operationId: string;
  /** Shown in FIDELITY.md, so say why rather than "todo". */
  reason: string;
}

export interface ModuleDeps {
  runtime: AppRuntime;
  storage: Storage;
  /** Wraps a control-API handler so it requires the admin token. */
  admin: (handler: (request: Request) => Response | Promise<Response>) => (request: Request) => Response | Promise<Response>;
  /** Bun exposes matched path parameters on the request object. */
  param: (request: Request, name: string) => string;
  json: (request: Request) => Promise<unknown>;
}

/**
 * One module per Mercado Pago product. Every spec operation must appear in exactly one
 * module, either in `operations` or in `pending` — `routes.test.ts` enforces it.
 */
export interface RouteModule {
  name: string;
  operations: readonly string[];
  pending: readonly PendingOperation[];
  routes(deps: ModuleDeps): RouteTable;
}

export const notImplemented = (operationIds: readonly string[], reason: string): PendingOperation[] =>
  operationIds.map((operationId) => ({ operationId, reason }));
