import { describe, expect, test } from 'bun:test';
import { VERSION } from '@payground/server';
import { main } from './index.ts';
import { testEnv } from './testing.ts';

describe('cli', () => {
  test('--version prints the version', async () => {
    const { env, out } = testEnv();
    expect(await main(['--version'], env)).toBe(0);
    expect(out).toEqual([VERSION]);
  });

  test('-v is the short form', async () => {
    const { env, out } = testEnv();
    expect(await main(['-v'], env)).toBe(0);
    expect(out).toEqual([VERSION]);
  });

  test('--help prints the usage on stdout', async () => {
    const { env, out } = testEnv();
    expect(await main(['--help'], env)).toBe(0);
    expect(out.join('\n')).toContain('build-dashboard');
  });

  test('no arguments is a usage error', async () => {
    const { env, err } = testEnv();
    expect(await main([], env)).toBe(2);
    expect(err[0]).toBe('missing command');
  });

  test('an unknown command is a usage error', async () => {
    const { env, err } = testEnv();
    expect(await main(['nope'], env)).toBe(2);
    expect(err[0]).toBe('unknown command: nope');
  });

  test('an unknown global option is a usage error', async () => {
    const { env, err } = testEnv();
    expect(await main(['--bogus'], env)).toBe(2);
    expect(err[0]).toContain('bogus');
  });

  test('an unknown option of a command is a usage error', async () => {
    const { env, err } = testEnv();
    expect(await main(['seed', '--nope'], env)).toBe(2);
    expect(err[0]).toContain('nope');
  });

  test('a missing option value is a usage error', async () => {
    const { env, err } = testEnv();
    expect(await main(['reset', '--db'], env)).toBe(2);
    expect(err[0]).toContain('argument missing');
  });

  test('every command answers --help with exit code 0', async () => {
    for (const command of ['start', 'seed', 'reset', 'sandbox', 'build-dashboard']) {
      const { env, out } = testEnv();
      expect(await main([command, '--help'], env)).toBe(0);
      expect(out.join('\n')).toContain('Usage: payground');
    }
  });
});
