import { err, ok, type Result } from '@payground/core';
import type { SafeFetchError } from './index.ts';

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/;
const CHUNK_SIZE_LINE = /^[0-9a-fA-F]{1,15}$/;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 8 * 1024;

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

export function isValidMethod(method: string): boolean {
  return TOKEN.test(method);
}

export function encodeRequest(input: {
  method: string;
  target: string;
  hostHeader: string;
  headers: Record<string, string>;
  body: string | null;
}): Uint8Array {
  const encoder = new TextEncoder();
  const bodyBytes = input.body === null ? null : encoder.encode(input.body);
  const lines = [`${input.method} ${input.target} HTTP/1.1`, `Host: ${input.hostHeader}`, 'Connection: close'];
  for (const [name, value] of Object.entries(input.headers)) {
    // Framing headers are ours to set; CR/LF in a caller-supplied header would splice a second request.
    if (!TOKEN.test(name) || HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (/[\r\n\0]/.test(value)) continue;
    lines.push(`${name}: ${value}`);
  }
  if (bodyBytes !== null) lines.push(`Content-Length: ${bodyBytes.byteLength}`);
  const head = encoder.encode(`${lines.join('\r\n')}\r\n\r\n`);
  if (bodyBytes === null) return head;
  const out = new Uint8Array(head.byteLength + bodyBytes.byteLength);
  out.set(head, 0);
  out.set(bodyBytes, head.byteLength);
  return out;
}

export interface ParsedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

type Framing = 'head' | 'length' | 'chunked' | 'until-close' | 'done';

const malformed = (message: string): SafeFetchError => ({ kind: 'malformed_response', message });

function indexOfDoubleCrlf(buf: Uint8Array, from: number): number {
  for (let i = from; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

function indexOfCrlf(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.byteLength; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

const utf8 = new TextDecoder();

/** Header bytes are ISO-8859-1 by spec; decode without UTF-8 replacement so tokens stay comparable. */
function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, bytes.byteLength)));
  }
  return out;
}

export class ResponseParser {
  private buf = new Uint8Array(0);
  private received = 0;
  private state: Framing = 'head';
  private status = 0;
  private statusText = '';
  private headers: Record<string, string> = {};
  private contentLength = 0;
  private bodyStart = 0;
  private chunkPos = 0;
  private chunks: Uint8Array[] = [];
  private bodyLength = 0;

  constructor(
    private readonly maxResponseBytes: number,
    private readonly method: string,
  ) {}

  push(chunk: Uint8Array): Result<boolean, SafeFetchError> {
    this.received += chunk.byteLength;
    if (this.received > this.maxResponseBytes) return err({ kind: 'response_too_large', limit: this.maxResponseBytes });
    const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.byteLength);
    this.buf = next;
    return this.drive();
  }

  /** Called on socket close; resolves bodies framed by connection close. */
  finish(): Result<ParsedResponse, SafeFetchError> {
    if (this.state === 'done') return ok(this.result());
    if (this.state === 'until-close') {
      this.pushBody(this.buf.subarray(this.bodyStart));
      this.state = 'done';
      return ok(this.result());
    }
    if (this.state === 'head') return err(malformed('connection closed before response headers'));
    return err(malformed('connection closed before response body was complete'));
  }

  result(): ParsedResponse {
    const body = new Uint8Array(this.bodyLength);
    let offset = 0;
    for (const part of this.chunks) {
      body.set(part, offset);
      offset += part.byteLength;
    }
    return { status: this.status, statusText: this.statusText, headers: this.headers, body: utf8.decode(body) };
  }

  private pushBody(part: Uint8Array): void {
    if (part.byteLength === 0) return;
    this.chunks.push(part);
    this.bodyLength += part.byteLength;
  }

  private drive(): Result<boolean, SafeFetchError> {
    for (;;) {
      switch (this.state) {
        case 'head': {
          const end = indexOfDoubleCrlf(this.buf, 0);
          if (end < 0) {
            if (this.buf.byteLength > MAX_HEAD_BYTES) return err(malformed('response head exceeds 64 KiB'));
            return ok(false);
          }
          const parsed = this.parseHead(decodeLatin1(this.buf.subarray(0, end)));
          if (!parsed.ok) return parsed;
          this.bodyStart = end + 4;
          this.chunkPos = this.bodyStart;
          break;
        }
        case 'length': {
          const available = this.buf.byteLength - this.bodyStart;
          if (available < this.contentLength) return ok(false);
          this.pushBody(this.buf.subarray(this.bodyStart, this.bodyStart + this.contentLength));
          this.state = 'done';
          return ok(true);
        }
        case 'chunked': {
          const stepped = this.driveChunked();
          if (!stepped.ok) return stepped;
          if (!stepped.value) return ok(false);
          return ok(true);
        }
        case 'until-close':
          return ok(false);
        case 'done':
          return ok(true);
      }
    }
  }

  private parseHead(text: string): Result<boolean, SafeFetchError> {
    const lines = text.split('\r\n');
    const statusLine = lines[0] ?? '';
    const match = STATUS_LINE.exec(statusLine);
    if (match === null) return err(malformed(`invalid status line: ${JSON.stringify(statusLine.slice(0, 64))}`));
    this.status = Number(match[1]);
    this.statusText = match[2] ?? '';
    let lastName: string | null = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.startsWith(' ') || line.startsWith('\t')) {
        if (lastName === null) return err(malformed('folded header without a preceding header'));
        this.headers[lastName] = `${this.headers[lastName] as string} ${line.trim()}`;
        continue;
      }
      const colon = line.indexOf(':');
      if (colon <= 0) return err(malformed(`invalid header line: ${JSON.stringify(line.slice(0, 64))}`));
      const name = line.slice(0, colon);
      if (!TOKEN.test(name)) return err(malformed(`invalid header name: ${JSON.stringify(name.slice(0, 64))}`));
      const key = name.toLowerCase();
      const value = line.slice(colon + 1).trim();
      const previous = this.headers[key];
      this.headers[key] = previous === undefined ? value : `${previous}, ${value}`;
      lastName = key;
    }
    return this.selectFraming();
  }

  private selectFraming(): Result<boolean, SafeFetchError> {
    const transferEncoding = this.headers['transfer-encoding']?.toLowerCase();
    const contentLength = this.headers['content-length'];
    if (transferEncoding !== undefined && contentLength !== undefined) {
      // RFC 9112 6.1: a client receiving both MUST treat the message as unrecoverable (smuggling).
      return err(malformed('both Content-Length and Transfer-Encoding present'));
    }
    if (this.status < 200 || this.status === 204 || this.status === 304 || this.method === 'HEAD') {
      this.state = 'done';
      return ok(true);
    }
    if (transferEncoding !== undefined) {
      const codings = transferEncoding.split(',').map((c) => c.trim());
      if (codings.length !== 1 || codings[0] !== 'chunked') {
        return err(malformed(`unsupported transfer-encoding: ${transferEncoding.slice(0, 64)}`));
      }
      this.state = 'chunked';
      return ok(true);
    }
    if (contentLength !== undefined) {
      const values = contentLength.split(',').map((v) => v.trim());
      const first = values[0] as string;
      if (!/^\d{1,15}$/.test(first) || values.some((v) => v !== first)) {
        return err(malformed(`invalid content-length: ${contentLength.slice(0, 64)}`));
      }
      this.contentLength = Number(first);
      if (this.contentLength > this.maxResponseBytes) {
        return err({ kind: 'response_too_large', limit: this.maxResponseBytes });
      }
      this.state = 'length';
      return ok(true);
    }
    this.state = 'until-close';
    return ok(true);
  }

  private driveChunked(): Result<boolean, SafeFetchError> {
    for (;;) {
      const eol = indexOfCrlf(this.buf, this.chunkPos);
      if (eol < 0) {
        if (this.buf.byteLength - this.chunkPos > MAX_LINE_BYTES) return err(malformed('chunk size line too long'));
        return ok(false);
      }
      const line = decodeLatin1(this.buf.subarray(this.chunkPos, eol));
      const sizeText = (line.split(';')[0] as string).trim();
      if (!CHUNK_SIZE_LINE.test(sizeText)) {
        return err(malformed(`invalid chunk size: ${JSON.stringify(line.slice(0, 64))}`));
      }
      const size = Number.parseInt(sizeText, 16);
      if (size === 0) {
        const end = this.consumeTrailers(eol + 2);
        if (end < 0) return ok(false);
        this.state = 'done';
        return ok(true);
      }
      const dataStart = eol + 2;
      if (this.buf.byteLength < dataStart + size + 2) return ok(false);
      if (this.buf[dataStart + size] !== 13 || this.buf[dataStart + size + 1] !== 10) {
        return err(malformed('chunk not terminated by CRLF'));
      }
      if (this.bodyLength + size > this.maxResponseBytes) {
        return err({ kind: 'response_too_large', limit: this.maxResponseBytes });
      }
      this.pushBody(this.buf.subarray(dataStart, dataStart + size));
      this.chunkPos = dataStart + size + 2;
    }
  }

  /** Returns the offset past the trailer section, or -1 when more bytes are needed. */
  private consumeTrailers(from: number): number {
    let pos = from;
    for (;;) {
      const eol = indexOfCrlf(this.buf, pos);
      if (eol < 0) return -1;
      if (eol === pos) return pos + 2;
      pos = eol + 2;
    }
  }
}
