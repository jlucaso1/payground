import { describe, expect, test } from 'bun:test';
import { isBlockedAddress } from './index.ts';

const blocked: readonly (readonly [string, string])[] = [
  ['127.0.0.1', 'ipv4 loopback'],
  ['127.0.0.0', 'ipv4 loopback'],
  ['127.255.255.255', 'ipv4 loopback'],
  ['0.0.0.0', 'ipv4 this-network'],
  ['0.255.255.255', 'ipv4 this-network'],
  ['10.0.0.0', 'ipv4 private'],
  ['10.255.255.255', 'ipv4 private'],
  ['172.16.0.0', 'ipv4 private'],
  ['172.31.255.255', 'ipv4 private'],
  ['192.168.0.0', 'ipv4 private'],
  ['192.168.255.255', 'ipv4 private'],
  ['169.254.0.0', 'ipv4 link-local'],
  ['169.254.169.254', 'ipv4 link-local'],
  ['169.254.255.255', 'ipv4 link-local'],
  ['100.64.0.0', 'ipv4 cgnat'],
  ['100.127.255.255', 'ipv4 cgnat'],
  ['224.0.0.0', 'ipv4 multicast'],
  ['239.255.255.255', 'ipv4 multicast'],
  ['240.0.0.0', 'ipv4 reserved'],
  ['254.255.255.255', 'ipv4 reserved'],
  ['255.255.255.255', 'ipv4 broadcast'],
  ['::1', 'ipv6 loopback'],
  ['0:0:0:0:0:0:0:1', 'ipv6 loopback'],
  ['::', 'ipv6 unspecified'],
  ['0000:0000:0000:0000:0000:0000:0000:0000', 'ipv6 unspecified'],
  ['fc00::1', 'ipv6 unique-local'],
  ['fdff:ffff::1', 'ipv6 unique-local'],
  ['fe80::1', 'ipv6 link-local'],
  ['febf:ffff::1', 'ipv6 link-local'],
  ['ff00::1', 'ipv6 multicast'],
  ['ff02::1', 'ipv6 multicast'],
  ['::ffff:127.0.0.1', 'ipv4-mapped ipv4 loopback'],
  ['::ffff:169.254.169.254', 'ipv4-mapped ipv4 link-local'],
  ['::ffff:10.0.0.1', 'ipv4-mapped ipv4 private'],
  ['0:0:0:0:0:ffff:192.168.1.1', 'ipv4-mapped ipv4 private'],
  ['::ffff:7f00:1', 'ipv4-mapped ipv4 loopback'],
  ['::127.0.0.1', 'ipv4-compatible ipv4 loopback'],
  ['::0.0.0.2', 'ipv4-compatible ipv4 this-network'],
  ['64:ff9b::127.0.0.1', 'nat64 64:ff9b::/96 ipv4 loopback'],
  ['not-an-ip', 'unparsable'],
  ['', 'unparsable'],
  ['1.2.3', 'unparsable'],
  ['1.2.3.4.5', 'unparsable'],
  ['256.1.1.1', 'unparsable'],
  ['010.0.0.1', 'unparsable'],
  ['1.2.3.-4', 'unparsable'],
  ['::1::2', 'unparsable'],
  ['fe80::1%eth0', 'unparsable'],
  ['12345::1', 'unparsable'],
  ['1:2:3:4:5:6:7', 'unparsable'],
];

const allowed: readonly string[] = [
  '11.0.0.0',
  '9.255.255.255',
  '172.15.255.255',
  '172.32.0.0',
  '192.167.255.255',
  '192.169.0.0',
  '169.253.255.255',
  '169.255.0.0',
  '100.63.255.255',
  '100.128.0.0',
  '223.255.255.255',
  '1.1.1.1',
  '8.8.8.8',
  '203.0.113.7',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '::ffff:8.8.8.8',
  '::ffff:0808:0808',
  'fbff:ffff::1',
  'fe00::1',
  'fec0::1',
  '64:ff9b::8.8.8.8',
];

describe('isBlockedAddress', () => {
  for (const [address, reason] of blocked) {
    test(`blocks ${address || '<empty>'}`, () => {
      const verdict = isBlockedAddress(address);
      expect(verdict.blocked).toBe(true);
      expect(verdict.reason).toContain(reason);
    });
  }

  for (const address of allowed) {
    test(`allows ${address}`, () => {
      expect(isBlockedAddress(address)).toEqual({ blocked: false, reason: '' });
    });
  }

  test('boundaries around 172.16.0.0/12 are exact', () => {
    expect(isBlockedAddress('172.15.255.255').blocked).toBe(false);
    expect(isBlockedAddress('172.16.0.0').blocked).toBe(true);
    expect(isBlockedAddress('172.31.255.255').blocked).toBe(true);
    expect(isBlockedAddress('172.32.0.0').blocked).toBe(false);
  });
});
