export interface TicketInput {
  barcode: string;
  line: string;
  amount: number;
  dueDate: Date | null;
  payerName: string;
  payerDocument: string;
  description: string;
  merchantName: string;
  reference: string;
}

/** Interleaved 2 of 5 digit patterns; `true` is a wide element. Five elements per digit. */
const ITF_PATTERNS: readonly (readonly boolean[])[] = [
  [false, false, true, true, false], // 0
  [true, false, false, false, true], // 1
  [false, true, false, false, true], // 2
  [true, true, false, false, false], // 3
  [false, false, true, false, true], // 4
  [true, false, true, false, false], // 5
  [false, true, true, false, false], // 6
  [false, false, false, true, true], // 7
  [true, false, false, true, false], // 8
  [false, true, false, true, false], // 9
];

export const ITF_NARROW = 2;
/** Boletos are printed with a 3:1 wide-to-narrow ratio (FEBRABAN barcode layout). */
export const ITF_WIDE = ITF_NARROW * 3;
const ITF_QUIET = ITF_NARROW * 10;
const ITF_HEIGHT = 50;

interface Element {
  bar: boolean;
  width: number;
}

function itfElements(barcode44: string): Element[] {
  const out: Element[] = [];
  // Start pattern: four narrow elements (bar, space, bar, space).
  for (let i = 0; i < 4; i++) out.push({ bar: i % 2 === 0, width: ITF_NARROW });
  for (let i = 0; i < barcode44.length; i += 2) {
    const bars = ITF_PATTERNS[Number(barcode44[i])] as readonly boolean[];
    const spaces = ITF_PATTERNS[Number(barcode44[i + 1])] as readonly boolean[];
    for (let k = 0; k < 5; k++) {
      out.push({ bar: true, width: bars[k] === true ? ITF_WIDE : ITF_NARROW });
      out.push({ bar: false, width: spaces[k] === true ? ITF_WIDE : ITF_NARROW });
    }
  }
  // Stop pattern: wide bar, narrow space, narrow bar.
  out.push({ bar: true, width: ITF_WIDE }, { bar: false, width: ITF_NARROW }, { bar: true, width: ITF_NARROW });
  return out;
}

export function barcodeSvg(barcode44: string): string {
  if (!/^\d{44}$/.test(barcode44)) throw new TypeError('barcodeSvg expects the 44-digit boleto barcode');

  const elements = itfElements(barcode44);
  const span = elements.reduce((sum, e) => sum + e.width, 0);
  const width = span + ITF_QUIET * 2;

  let x = ITF_QUIET;
  let rects = '';
  for (const element of elements) {
    if (element.bar) rects += `<rect x="${x}" y="0" width="${element.width}" height="${ITF_HEIGHT}"/>`;
    x += element.width;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ITF_HEIGHT}" viewBox="0 0 ${width} ${ITF_HEIGHT}" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${width}" height="${ITF_HEIGHT}" fill="#fff"/>` +
    `<g fill="#000">${rects}</g></svg>`
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatBrl(amount: number): string {
  if (!Number.isFinite(amount)) return 'R$ -';
  const cents = Math.round(Math.abs(amount) * 100);
  const integer = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${amount < 0 ? '-' : ''}R$ ${integer},${String(cents % 100).padStart(2, '0')}`;
}

/** Rendered from the UTC calendar day so the output does not depend on the host timezone. */
export function formatDate(date: Date | null): string {
  if (date === null || !Number.isFinite(date.getTime())) return 'Contra apresentacao';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

function row(label: string, value: string): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

const STYLE = `body{font-family:Arial,Helvetica,sans-serif;color:#000;margin:24px}
.ticket{max-width:760px;border:1px solid #000;padding:16px}
.line{font-family:"Courier New",monospace;font-size:18px;font-weight:bold;letter-spacing:1px;margin:8px 0 16px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #999;padding:6px 8px;text-align:left;font-size:13px;vertical-align:top}
th{width:180px;background:#f2f2f2;font-weight:normal}
.barcode{margin-top:16px}
.barcode svg{max-width:100%;height:auto}
@media print{body{margin:0}.ticket{border:none}}`;

export function ticketHtml(input: TicketInput): string {
  return (
    '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    `<title>Boleto ${escapeHtml(input.reference)}</title><style>${STYLE}</style></head><body>` +
    `<div class="ticket"><h1>${escapeHtml(input.merchantName)}</h1>` +
    `<div class="line">${escapeHtml(input.line)}</div><table>` +
    row('Vencimento', formatDate(input.dueDate)) +
    row('Valor', formatBrl(input.amount)) +
    row('Beneficiario', input.merchantName) +
    row('Pagador', input.payerName) +
    row('Documento', input.payerDocument) +
    row('Descricao', input.description) +
    row('Nosso numero', input.reference) +
    `</table><div class="barcode">${barcodeSvg(input.barcode)}</div></div></body></html>`
  );
}
