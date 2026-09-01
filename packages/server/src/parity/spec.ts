import { ROUTES, type RouteSpec } from '@payground/mercadopago/generated/routes.ts';
import { OVERLAY } from '../../../../spec/overlay.ts';
import document from '../../../../spec/spec3.json';
import { normaliseRoute } from '../http/handler.ts';

export interface SpecSchema {
  $ref?: string;
  type?: string | readonly string[];
  enum?: readonly (string | number)[];
  properties?: Record<string, SpecSchema>;
  required?: readonly string[];
  items?: SpecSchema;
  allOf?: readonly SpecSchema[];
  additionalProperties?: boolean | SpecSchema;
  nullable?: boolean;
  minimum?: number;
}

interface SpecOperation {
  operationId?: string;
  responses?: Record<string, { content?: Record<string, { schema?: SpecSchema }> }>;
}

interface SpecDocument {
  paths: Record<string, Record<string, SpecOperation>>;
  components: { schemas: Record<string, SpecSchema> };
}

const doc = document as SpecDocument;

/** The generated validators already carry the overlay, so the schemas here must too. */
function withOverlay(): Record<string, SpecSchema> {
  const schemas: Record<string, SpecSchema> = structuredClone(doc.components.schemas);
  for (const entry of OVERLAY) {
    const target = schemas[entry.schema];
    if (target === undefined) continue;
    target.properties = { ...target.properties, ...(entry.properties as Record<string, SpecSchema> | undefined) };
    if (entry.required !== undefined) target.required = [...new Set([...(target.required ?? []), ...entry.required])];
  }
  return schemas;
}

export const SCHEMAS: Record<string, SpecSchema> = withOverlay();

export const refName = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1);

/** Follows `$ref` and flattens `allOf`, which the spec uses for Store and POS. */
export function resolve(schema: SpecSchema): SpecSchema {
  let current = schema;
  while (current.$ref !== undefined) {
    const next = SCHEMAS[refName(current.$ref)];
    if (next === undefined) return {};
    current = next;
  }
  if (current.allOf === undefined) return current;

  const merged: SpecSchema = { ...current };
  delete merged.allOf;
  for (const member of current.allOf) {
    const part = resolve(member);
    if (merged.type === undefined && part.type !== undefined) merged.type = part.type;
    merged.properties = { ...merged.properties, ...part.properties };
    if (part.required !== undefined) merged.required = [...(merged.required ?? []), ...part.required];
    if (part.additionalProperties !== undefined) merged.additionalProperties = part.additionalProperties;
  }
  return merged;
}

const RESPONSES = new Map<string, SpecSchema>();
for (const item of Object.values(doc.paths)) {
  for (const operation of Object.values(item)) {
    const id = operation.operationId;
    if (id === undefined) continue;
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      const schema = response.content?.['application/json']?.schema;
      if (schema !== undefined) RESPONSES.set(`${id} ${status}`, schema);
    }
  }
}

export const responseSchema = (operationId: string, status: number): SpecSchema | undefined =>
  RESPONSES.get(`${operationId} ${status}`) ?? RESPONSES.get(`${operationId} default`);

/**
 * The request history labels routes with `normaliseRoute`, which collapses every
 * identifier to `:id`. Spec patterns name their parameters, so both sides are folded
 * onto the same key before matching.
 */
export function routeKey(method: string, route: string): string {
  const path = route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
  return `${method.toUpperCase()} ${normaliseRoute(path.replaceAll(/(:[A-Za-z_][\w-]*|\{[^}]+\})/g, ':id'))}`;
}

const BY_ROUTE = new Map<string, RouteSpec>();
for (const route of ROUTES) BY_ROUTE.set(routeKey(route.method, route.pattern), route);

export const operationFor = (method: string, route: string): RouteSpec | undefined =>
  BY_ROUTE.get(routeKey(method, route));

export const operationById = (operationId: string): RouteSpec | undefined =>
  ROUTES.find((route) => route.operationId === operationId);
