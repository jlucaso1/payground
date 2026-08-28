export interface AddressVerdict {
  blocked: boolean;
  reason: string;
}

const ALLOWED: AddressVerdict = { blocked: false, reason: '' };
const block = (reason: string): AddressVerdict => ({ blocked: true, reason });

const IPV4_PART = /^(0|[1-9][0-9]{0,2})$/;

export function parseIPv4(input: string): readonly number[] | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    // Leading zeros are octal-ambiguous; refuse instead of guessing.
    if (!IPV4_PART.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

function parseGroups(part: string, allowEmbeddedIPv4: boolean): number[] | null {
  if (part === '') return [];
  const tokens = part.split(':');
  const groups: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const last = i === tokens.length - 1;
    if (token.includes('.')) {
      if (!last || !allowEmbeddedIPv4) return null;
      const v4 = parseIPv4(token);
      if (v4 === null) return null;
      groups.push(((v4[0] as number) << 8) | (v4[1] as number), ((v4[2] as number) << 8) | (v4[3] as number));
      continue;
    }
    if (!HEX_GROUP.test(token)) return null;
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}

export function parseIPv6(input: string): Uint8Array | null {
  // Zone identifiers are never legitimate for an outbound webhook target.
  if (input.includes('%')) return null;
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const head = parseGroups(halves[0] as string, !compressed);
  if (head === null) return null;
  let groups: number[];
  if (!compressed) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const tail = parseGroups(halves[1] as string, true);
    if (tail === null) return null;
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i] as number;
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function classifyIPv4(bytes: readonly number[]): AddressVerdict {
  const a = bytes[0] as number;
  const b = bytes[1] as number;
  const c = bytes[2] as number;
  const d = bytes[3] as number;
  if (a === 255 && b === 255 && c === 255 && d === 255) return block('ipv4 broadcast 255.255.255.255');
  if (a === 127) return block('ipv4 loopback 127.0.0.0/8');
  if (a === 0) return block('ipv4 this-network 0.0.0.0/8');
  if (a === 10) return block('ipv4 private 10.0.0.0/8');
  if (a === 172 && b >= 16 && b <= 31) return block('ipv4 private 172.16.0.0/12');
  if (a === 192 && b === 168) return block('ipv4 private 192.168.0.0/16');
  if (a === 169 && b === 254) return block('ipv4 link-local 169.254.0.0/16');
  if (a === 100 && b >= 64 && b <= 127) return block('ipv4 cgnat 100.64.0.0/10');
  if (a >= 224 && a <= 239) return block('ipv4 multicast 224.0.0.0/4');
  if (a >= 240) return block('ipv4 reserved 240.0.0.0/4');
  return ALLOWED;
}

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
}

function embedded(bytes: Uint8Array, offset: number, label: string): AddressVerdict {
  const verdict = classifyIPv4([
    bytes[offset] as number,
    bytes[offset + 1] as number,
    bytes[offset + 2] as number,
    bytes[offset + 3] as number,
  ]);
  return verdict.blocked ? block(`${label} ${verdict.reason}`) : ALLOWED;
}

function classifyIPv6(bytes: Uint8Array): AddressVerdict {
  if (allZero(bytes, 0, 16)) return block('ipv6 unspecified ::');
  if (allZero(bytes, 0, 15) && bytes[15] === 1) return block('ipv6 loopback ::1');
  // Classic bypass: an IPv4 address wearing an IPv6 costume must be judged as IPv4.
  if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return embedded(bytes, 12, 'ipv4-mapped');
  if (allZero(bytes, 0, 12)) return embedded(bytes, 12, 'ipv4-compatible');
  // NAT64 well-known prefix 64:ff9b::/96 also carries a routable IPv4 destination.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && allZero(bytes, 4, 12)) {
    return embedded(bytes, 12, 'nat64 64:ff9b::/96');
  }
  const first = bytes[0] as number;
  const second = bytes[1] as number;
  if ((first & 0xfe) === 0xfc) return block('ipv6 unique-local fc00::/7');
  if (first === 0xfe && (second & 0xc0) === 0x80) return block('ipv6 link-local fe80::/10');
  if (first === 0xff) return block('ipv6 multicast ff00::/8');
  return ALLOWED;
}

export function isBlockedAddress(address: string): AddressVerdict {
  const v4 = parseIPv4(address);
  if (v4 !== null) return classifyIPv4(v4);
  const v6 = parseIPv6(address);
  if (v6 !== null) return classifyIPv6(v6);
  return block('unparsable address');
}

export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}
