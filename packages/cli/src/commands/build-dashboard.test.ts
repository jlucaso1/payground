import { describe, expect, test } from 'bun:test';
import { main } from '../index.ts';
import { testEnv } from '../testing.ts';

describe('build-dashboard', () => {
  test('--help documents the output directory', async () => {
    const { env, out } = testEnv();
    expect(await main(['build-dashboard', '--help'], env)).toBe(0);
    expect(out.join('\n')).toContain('--out <dir>');
  });

  test('an unknown option is a usage error', async () => {
    const { env, err } = testEnv();
    expect(await main(['build-dashboard', '--minify'], env)).toBe(2);
    expect(err[0]).toContain('minify');
  });

  test('reports a failure when the output directory cannot be written', async () => {
    const { env, err } = testEnv();
    expect(await main(['build-dashboard', '--out', '/proc/payground-forbidden'], env)).toBe(1);
    expect(err[0]).toContain('dashboard build failed');
  });
});
