import type { Database } from 'bun:sqlite';
import {
  type DocumentKind,
  type DocumentQuery,
  type DocumentRepository,
  type Page,
  type SandboxId,
  type StoredDocument,
  isJsonObject,
} from '@payground/core';

interface Row {
  kind: string;
  id: string;
  sequence: number;
  status: string;
  external_reference: string | null;
  lookup: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  doc: string;
}

const COLUMNS =
  'kind, id, sequence, status, external_reference, lookup, created_at, updated_at, expires_at, doc';

function toDocument(row: Row): StoredDocument {
  const parsed: unknown = JSON.parse(row.doc);
  if (!isJsonObject(parsed)) throw new Error(`corrupt document: ${row.kind}/${row.id}`);
  return {
    kind: row.kind as DocumentKind,
    id: row.id,
    sequence: row.sequence,
    status: row.status,
    externalReference: row.external_reference,
    lookup: row.lookup,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    doc: parsed,
  };
}

/**
 * Preferences, orders, customers, tokens and subscriptions have no domain behaviour of
 * their own in V1, they are provider documents. One table with indexed lookup columns
 * beats seven near-identical schemas.
 */
export class SqliteDocumentRepository implements DocumentRepository {
  constructor(
    private readonly db: Database,
    private readonly sandbox: SandboxId,
  ) {}

  private bind(document: StoredDocument): Record<string, string | number | null> {
    return {
      $sandbox_id: this.sandbox,
      $kind: document.kind,
      $id: document.id,
      $sequence: document.sequence,
      $status: document.status,
      $external_reference: document.externalReference,
      $lookup: document.lookup,
      $created_at: document.createdAt,
      $updated_at: document.updatedAt,
      $expires_at: document.expiresAt,
      $doc: JSON.stringify(document.doc),
    };
  }

  insert(document: StoredDocument): void {
    this.db
      .query(
        `insert into documents (sandbox_id, ${COLUMNS}) values (
          $sandbox_id, $kind, $id, $sequence, $status, $external_reference, $lookup,
          $created_at, $updated_at, $expires_at, $doc)`,
      )
      .run(this.bind(document));
  }

  update(document: StoredDocument): void {
    const result = this.db
      .query(
        `update documents set status = $status, external_reference = $external_reference,
           lookup = $lookup, updated_at = $updated_at, expires_at = $expires_at, doc = $doc
         where sandbox_id = $sandbox_id and kind = $kind and id = $id`,
      )
      .run(this.bind(document));
    if (result.changes === 0) throw new Error(`document not found: ${document.kind}/${document.id}`);
  }

  get(kind: DocumentKind, id: string): StoredDocument | null {
    const row = this.db
      .query<Row, [string, string, string]>(
        `select ${COLUMNS} from documents where sandbox_id = ? and kind = ? and id = ?`,
      )
      .get(this.sandbox, kind, id);
    return row === null ? null : toDocument(row);
  }

  bySequence(kind: DocumentKind, sequence: number): StoredDocument | null {
    const row = this.db
      .query<Row, [string, string, number]>(
        `select ${COLUMNS} from documents where sandbox_id = ? and kind = ? and sequence = ?`,
      )
      .get(this.sandbox, kind, sequence);
    return row === null ? null : toDocument(row);
  }

  byLookup(kind: DocumentKind, lookup: string): StoredDocument | null {
    const row = this.db
      .query<Row, [string, string, string]>(
        `select ${COLUMNS} from documents where sandbox_id = ? and kind = ? and lookup = ? order by created_at limit 1`,
      )
      .get(this.sandbox, kind, lookup);
    return row === null ? null : toDocument(row);
  }

  search(kind: DocumentKind, query: DocumentQuery): Page<StoredDocument> {
    const where = ['sandbox_id = $sandbox_id', 'kind = $kind'];
    const params: Record<string, string | number> = { $sandbox_id: this.sandbox, $kind: kind };

    if (query.status !== undefined) {
      where.push('status = $status');
      params['$status'] = query.status;
    }
    if (query.externalReference !== undefined) {
      where.push('external_reference = $external_reference');
      params['$external_reference'] = query.externalReference;
    }
    if (query.lookup !== undefined) {
      where.push('lookup = $lookup');
      params['$lookup'] = query.lookup;
    }
    if (query.text !== undefined && query.text !== '') {
      // Explicit ESCAPE, otherwise a % or _ in the search text would act as a wildcard.
      where.push(
        "(id like $text escape '\\' or lookup like $text escape '\\' or doc like $text escape '\\')",
      );
      params['$text'] = `%${query.text.replace(/[%_\\]/g, '\\$&')}%`;
    }

    const clause = where.join(' and ');
    const total = this.db
      .query<{ n: number }, typeof params>(`select count(*) as n from documents where ${clause}`)
      .get(params);
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);
    const order = query.order === 'asc' ? 'asc' : 'desc';

    const rows = this.db
      .query<Row, Record<string, string | number>>(
        `select ${COLUMNS} from documents where ${clause} order by created_at ${order}, sequence ${order}
         limit $limit offset $offset`,
      )
      .all({ ...params, $limit: limit, $offset: offset });

    return { total: total?.n ?? 0, limit, offset, results: rows.map(toDocument) };
  }

  remove(kind: DocumentKind, id: string): boolean {
    return (
      this.db
        .query('delete from documents where sandbox_id = ? and kind = ? and id = ?')
        .run(this.sandbox, kind, id).changes > 0
    );
  }

  countByKind(): Readonly<Record<string, number>> {
    const rows = this.db
      .query<{ kind: string; n: number }, [string]>(
        'select kind, count(*) as n from documents where sandbox_id = ? group by kind',
      )
      .all(this.sandbox);
    const out: Record<string, number> = {};
    for (const row of rows) out[row.kind] = row.n;
    return out;
  }

  expired(kind: DocumentKind, at: number): readonly StoredDocument[] {
    return this.db
      .query<Row, [string, string, number]>(
        `select ${COLUMNS} from documents where sandbox_id = ? and kind = ?
           and expires_at is not null and expires_at <= ? order by expires_at`,
      )
      .all(this.sandbox, kind, at)
      .map(toDocument);
  }
}
