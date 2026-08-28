import { type JsonObject, type JsonValue, isJsonObject } from '@payground/core';

/** Typed readers for `StoredDocument.doc`, which is untyped JSON by design. */
export const readString = (doc: JsonObject, key: string): string | null => {
  const value = doc[key];
  return typeof value === 'string' ? value : null;
};

export const readNumber = (doc: JsonObject, key: string): number | null => {
  const value = doc[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export const readBoolean = (doc: JsonObject, key: string): boolean => doc[key] === true;

export const readObject = (doc: JsonObject, key: string): JsonObject => {
  const value = doc[key];
  return isJsonObject(value) ? value : {};
};

export const readArray = (doc: JsonObject, key: string): JsonValue[] => {
  const value = doc[key];
  return Array.isArray(value) ? value : [];
};

export const readObjects = (doc: JsonObject, key: string): JsonObject[] =>
  readArray(doc, key).filter((entry): entry is JsonObject => isJsonObject(entry));
