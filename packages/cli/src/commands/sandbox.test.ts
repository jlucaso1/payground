import { describe, expect, test } from 'bun:test';
import { main } from '../index.ts';
import { testEnv } from '../testing.ts';

describe('sandbox', () => {
  test('list reports an empty database', async () => {
    const { env, out } = testEnv();
    expect(await main(['sandbox', 'list'], env)).toBe(0);
    expect(out).toEqual(['no sandboxes']);
  });

  test('create prints the credentials and stores the sandbox', async () => {
    const { env, storage, out } = testEnv();
    expect(await main(['sandbox', 'create', '--name', 'acme'], env)).toBe(0);
    const created = storage.sandboxes.list()[0];
    expect(created?.name).toBe('acme');
    expect(out.join('\n')).toContain(created?.accessToken ?? 'missing');
    expect(out.join('\n')).toContain('webhook secret');
  });

  test('list prints one line per sandbox', async () => {
    const { env, out } = testEnv();
    await main(['sandbox', 'create', '--name', 'a'], env);
    await main(['sandbox', 'create', '--name', 'b'], env);
    out.length = 0;
    expect(await main(['sandbox', 'list'], env)).toBe(0);
    expect(out).toHaveLength(2);
  });

  test('show returns the sandbox', async () => {
    const { env, storage, out } = testEnv();
    await main(['sandbox', 'create', '--name', 'acme'], env);
    const id = storage.sandboxes.list()[0]?.id ?? '';
    out.length = 0;
    expect(await main(['sandbox', 'show', id], env)).toBe(0);
    expect(out[0]).toBe(`id              ${id}`);
  });

  test('delete removes the sandbox and its data', async () => {
    const { env, storage } = testEnv();
    await main(['sandbox', 'create', '--name', 'acme'], env);
    await main(['seed'], env);
    const id = storage.sandboxes.list()[0]?.id ?? '';
    expect(await main(['sandbox', 'delete', id], env)).toBe(0);
    expect(storage.sandboxes.list()).toHaveLength(0);
  });

  test('show and delete fail when the sandbox is unknown', async () => {
    const { env, err } = testEnv();
    expect(await main(['sandbox', 'show', 'nope'], env)).toBe(1);
    expect(await main(['sandbox', 'delete', 'nope'], env)).toBe(1);
    expect(err).toEqual(['sandbox not found: nope', 'sandbox not found: nope']);
  });

  test('show and delete require an id', async () => {
    const { env, err } = testEnv();
    expect(await main(['sandbox', 'show'], env)).toBe(2);
    expect(err[0]).toBe('sandbox show requires an id');
  });

  test('create requires a name', async () => {
    const { env, err } = testEnv();
    expect(await main(['sandbox', 'create'], env)).toBe(2);
    expect(err[0]).toBe('sandbox create requires --name');
  });

  test('an unknown subcommand is a usage error', async () => {
    const { env, err } = testEnv();
    expect(await main(['sandbox', 'purge'], env)).toBe(2);
    expect(err[0]).toBe('unknown subcommand: purge');
  });

  test('a missing subcommand is a usage error', async () => {
    const { env, err } = testEnv();
    expect(await main(['sandbox'], env)).toBe(2);
    expect(err[0]).toBe('missing subcommand');
  });
});
