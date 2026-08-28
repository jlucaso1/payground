import { describe, expect, test } from 'bun:test';
import { SeededRandom } from '@payground/core/testing.ts';
import { unwrap } from '@payground/core';
import { barcode, linhaDigitavel } from './barcode.ts';
import { type TicketInput, barcodeSvg, escapeHtml, formatBrl, formatDate, ticketHtml } from './ticket.ts';

const KNOWN_BARCODE = '00193373700000001000500940144816060680935031';
const KNOWN_LINE = '00190.50095 40144.816069 06809.350314 3 37370000000100';

/**
 * Independent Interleaved 2 of 5 decoder. It only looks at the rendered geometry: bar rects come
 * from the SVG, spaces are the gaps between consecutive bars.
 */
const ITF_TABLE: Record<string, string> = {
  NNWWN: '0',
  WNNNW: '1',
  NWNNW: '2',
  WWNNN: '3',
  NNWNW: '4',
  WNWNN: '5',
  NWWNN: '6',
  NNNWW: '7',
  WNNWN: '8',
  NWNWN: '9',
};

function decodeItf(svg: string): string {
  const bars: { x: number; width: number }[] = [];
  const group = /<g fill="#000">(.*?)<\/g>/s.exec(svg);
  expect(group).not.toBeNull();
  const rects = (group?.[1] ?? '').matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="(\d+)"\/>/g);
  for (const rect of rects) bars.push({ x: Number(rect[1]), width: Number(rect[2]) });
  expect(bars.length).toBeGreaterThan(0);

  const widths: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] as { x: number; width: number };
    widths.push(bar.width);
    const next = bars[i + 1];
    if (next !== undefined) {
      const gap = next.x - (bar.x + bar.width);
      expect(gap).toBeGreaterThan(0);
      widths.push(gap);
    }
  }

  const narrow = Math.min(...widths);
  const symbols = widths.map((w) => {
    if (w === narrow) return 'N';
    expect(w).toBe(narrow * 3);
    return 'W';
  });

  expect(symbols.slice(0, 4).join('')).toBe('NNNN'); // start
  expect(symbols.slice(-3).join('')).toBe('WNN'); // stop
  const payload = symbols.slice(4, -3);
  expect(payload.length % 10).toBe(0);

  let digits = '';
  for (let i = 0; i < payload.length; i += 10) {
    const group10 = payload.slice(i, i + 10);
    const barPattern = [0, 2, 4, 6, 8].map((k) => group10[k]).join('');
    const spacePattern = [1, 3, 5, 7, 9].map((k) => group10[k]).join('');
    const first = ITF_TABLE[barPattern];
    const second = ITF_TABLE[spacePattern];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    digits += `${first}${second}`;
  }
  return digits;
}

describe('barcodeSvg', () => {
  test('decodes back to the original digits', () => {
    expect(decodeItf(barcodeSvg(KNOWN_BARCODE))).toBe(KNOWN_BARCODE);
  });

  test('decodes back for thousands of random barcodes', () => {
    const rng = new SeededRandom(31);
    for (let i = 0; i < 2000; i++) {
      let freeField = '';
      for (let j = 0; j < 25; j++) freeField += rng.int(10);
      let bankCode = '';
      for (let j = 0; j < 3; j++) bankCode += rng.int(10);
      const bar = unwrap(
        barcode({
          bankCode,
          amount: rng.int(100_000_000) / 100,
          dueDate: rng.int(5) === 0 ? null : new Date(Date.UTC(1997, 9, 7) + (1000 + rng.int(9000)) * 86_400_000),
          freeField,
        }),
      );
      expect(decodeItf(barcodeSvg(bar))).toBe(bar);
    }
  });

  test('all ten digit patterns are exercised', () => {
    const bar = `${'01234567890123456789'.repeat(2)}0123`;
    expect(bar).toHaveLength(44);
    expect(decodeItf(barcodeSvg(bar))).toBe(bar);
  });

  test('svg geometry', () => {
    const svg = barcodeSvg(KNOWN_BARCODE);
    // 44 digits * 9 narrow-units each + 4 start units + 5 stop units = 405 narrow units.
    const span = 405 * 2;
    const width = span + 2 * 20;
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="50"`)).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  test('rejects anything that is not 44 digits', () => {
    for (const bad of ['', '1'.repeat(43), '1'.repeat(45), `${'1'.repeat(43)}a`]) {
      expect(() => barcodeSvg(bad)).toThrow(TypeError);
    }
  });
});

describe('escapeHtml', () => {
  test('escapes every dangerous character', () => {
    expect(escapeHtml(`<script>alert("x" + 'y' & 1)</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot; + &#39;y&#39; &amp; 1)&lt;/script&gt;',
    );
  });

  test('ampersand is escaped first, so it is not double-escaped', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml('')).toBe('');
  });
});

describe('formatBrl', () => {
  test('thousand separators and two decimals', () => {
    expect(formatBrl(0)).toBe('R$ 0,00');
    expect(formatBrl(1)).toBe('R$ 1,00');
    expect(formatBrl(1.5)).toBe('R$ 1,50');
    expect(formatBrl(1234.56)).toBe('R$ 1.234,56');
    expect(formatBrl(99_999_999.99)).toBe('R$ 99.999.999,99');
    expect(formatBrl(-1234.5)).toBe('-R$ 1.234,50');
    expect(formatBrl(Number.NaN)).toBe('R$ -');
  });
});

describe('formatDate', () => {
  test('UTC day, zero padded', () => {
    expect(formatDate(new Date(Date.UTC(2007, 11, 31)))).toBe('31/12/2007');
    expect(formatDate(new Date('2025-02-01T23:30:00.000Z'))).toBe('01/02/2025');
    expect(formatDate(null)).toBe('Contra apresentacao');
    expect(formatDate(new Date(Number.NaN))).toBe('Contra apresentacao');
  });
});

const TICKET: TicketInput = {
  barcode: KNOWN_BARCODE,
  line: KNOWN_LINE,
  amount: 1,
  dueDate: new Date(Date.UTC(2007, 11, 31)),
  payerName: 'Ana & Cia <Ltda>',
  payerDocument: '123.456.789-09',
  description: 'Pedido "42"',
  merchantName: "O'Brien Store",
  reference: '<img src=x onerror=alert(1)>',
};

describe('ticketHtml', () => {
  test('embeds the decodable barcode and the linha digitavel', () => {
    const html = ticketHtml(TICKET);
    const svg = /<svg[\s\S]*<\/svg>/.exec(html)?.[0] ?? '';
    expect(decodeItf(svg)).toBe(KNOWN_BARCODE);
    expect(html).toContain(KNOWN_LINE);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.endsWith('</html>')).toBe(true);
  });

  test('formats amount and due date', () => {
    const html = ticketHtml({ ...TICKET, amount: 1234.56 });
    expect(html).toContain('R$ 1.234,56');
    expect(html).toContain('31/12/2007');
    expect(ticketHtml({ ...TICKET, dueDate: null })).toContain('Contra apresentacao');
  });

  test('escapes every user-supplied value', () => {
    const html = ticketHtml(TICKET);
    for (const raw of [
      TICKET.payerName,
      TICKET.description,
      TICKET.merchantName,
      TICKET.reference,
    ]) {
      expect(escapeHtml(raw)).not.toBe(raw);
      expect(html).not.toContain(raw);
      expect(html).toContain(escapeHtml(raw));
    }
    expect(html).toContain(TICKET.payerDocument); // nothing to escape, must survive intact
    // The payload survives as inert text; what matters is that it never becomes markup.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });

  test('hostile values never introduce a tag or attribute break', () => {
    const rng = new SeededRandom(5);
    const pool = ['<', '>', '"', "'", '&', '/', 'a', ' ', 'script', 'onload=', 'ç', '北'];
    for (let i = 0; i < 500; i++) {
      let text = '';
      for (let j = 0; j < rng.int(20); j++) text += pool[rng.int(pool.length)] ?? 'a';
      const html = ticketHtml({ ...TICKET, payerName: text, description: text, merchantName: text, reference: text });
      // Every tag in the document must be one we emitted: no stray '<' survives escaping.
      for (const tag of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
        expect([
          'doctype',
          'html',
          'head',
          'meta',
          'title',
          'style',
          'body',
          'div',
          'h1',
          'table',
          'tr',
          'th',
          'td',
          'svg',
          'rect',
          'g',
        ]).toContain((tag[1] ?? '').toLowerCase());
      }
    }
  });
});

describe('end to end', () => {
  test('barcode -> linha digitavel -> printable ticket', () => {
    const bar = unwrap(
      barcode({
        bankCode: '237',
        amount: 250.75,
        dueDate: new Date(Date.UTC(2025, 1, 22)),
        freeField: '1234567890123456789012345',
      }),
    );
    const line = unwrap(linhaDigitavel(bar));
    const html = ticketHtml({ ...TICKET, barcode: bar, line, amount: 250.75 });
    expect(html).toContain(line);
    expect(html).toContain('R$ 250,75');
    expect(decodeItf(/<svg[\s\S]*<\/svg>/.exec(html)?.[0] ?? '')).toBe(bar);
  });
});
