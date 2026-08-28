export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: readonly (string | number)[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  nullable?: boolean;
  description?: string;
  minimum?: number;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, JsonSchema>;
    responses?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

export interface Operation {
  operationId?: string;
  summary?: string;
  deprecated?: boolean;
  security?: readonly Record<string, readonly string[]>[];
  parameters?: readonly Parameter[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema?: JsonSchema;
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const refName = (ref: string): string => {
  const name = ref.split('/').pop();
  if (name === undefined || name === '') throw new Error(`unresolvable $ref: ${ref}`);
  return name;
};

/** The spec mixes 3.1 (`type: [x, "null"]`) and 3.0 (`nullable: true`). */
export function normalise(schema: JsonSchema): { types: string[]; nullable: boolean } {
  const raw = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = schema.nullable === true || raw.includes('null');
  return { types: raw.filter((t) => t !== 'null'), nullable };
}
