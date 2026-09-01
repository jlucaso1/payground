import { DOCUMENT_KINDS, type JsonObject, type JsonValue, type KindCount } from '../api/client-documents.ts';
import { formatAmount, parseAmount } from './format.ts';

export interface KindEntry {
  kind: string;
  label: string;
  count: number;
  known: boolean;
}

export function kindLabel(kind: string): string {
  return kind.split('_').join(' ');
}

/** Every supported kind is listed, even with no documents, so the screen doubles as a catalogue. */
export function groupKinds(counts: readonly KindCount[]): KindEntry[] {
  const totals = new Map<string, number>();
  for (const entry of counts) {
    if (entry.kind === '') continue;
    const count = Number.isFinite(entry.count) ? Math.max(0, Math.trunc(entry.count)) : 0;
    totals.set(entry.kind, (totals.get(entry.kind) ?? 0) + count);
  }

  const known: KindEntry[] = DOCUMENT_KINDS.map((kind) => ({
    kind,
    label: kindLabel(kind),
    count: totals.get(kind) ?? 0,
    known: true,
  }));

  const extra: KindEntry[] = [...totals.keys()]
    .filter((kind) => !(DOCUMENT_KINDS as readonly string[]).includes(kind))
    .sort()
    .map((kind) => ({ kind, label: kindLabel(kind), count: totals.get(kind) ?? 0, known: false }));

  return [...known, ...extra];
}

export function firstPopulatedKind(entries: readonly KindEntry[]): string | null {
  return entries.find((entry) => entry.count > 0)?.kind ?? null;
}

export interface AmountField {
  path: string;
  text: string;
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function currencyOf(scope: JsonObject, fallback: string | null): string | null {
  const own = scope['currency_id'] ?? scope['currency'];
  return typeof own === 'string' && own !== '' ? own : fallback;
}

/**
 * Documents carry Mercado Pago shaped decimal amounts; they are converted to
 * integer minor units before formatting so no float maths is involved.
 */
function collect(scope: JsonObject, prefix: string, fallback: string | null, out: AmountField[]): void {
  const currency = currencyOf(scope, fallback);
  for (const [key, value] of Object.entries(scope)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'number' && /amount$/.test(key) && currency !== null) {
      const minor = parseAmount(String(value), currency);
      if (minor !== null) out.push({ path, text: formatAmount(minor, currency) });
      continue;
    }
    if (isObject(value) && prefix === '') collect(value, path, currency, out);
  }
}

export function documentAmounts(doc: JsonValue | undefined): AmountField[] {
  const out: AmountField[] = [];
  if (doc !== undefined && isObject(doc)) collect(doc, '', null, out);
  return out;
}
