import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../../../cli/src/index.ts');
const PIX = { transaction_amount: 100, payment_method_id: 'pix', payer: { email: 'a@b.c' } };

interface Instance {
  origin: string;
  token: string;
  process: Bun.Subprocess;
  exited: Promise<number>;
}

const running: Instance[] = [];
const files: string[] = [];

afterEach(async () => {
  for (const instance of running.splice(0)) {
    instance.process.kill('SIGKILL');
    await instance.exited;
  }
  for (const file of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  }
});

/** Reads the banner the CLI prints, which is the only place the ephemeral port appears. */
async function start(db: string): Promise<Instance> {
  // process.execPath rather than 'bun': the test runner's PATH is not guaranteed.
  const child = Bun.spawn([process.execPath, CLI, 'start', '--db', db, '--port', '0', '--drain-timeout', '3000'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exited = child.exited;
  // Registered by identity, not by position: two overlapping start() calls would otherwise
  // overwrite each other's slot and leave a child alive after the database is deleted.
  const slot: Instance = { origin: '', token: '', process: child, exited };
  running.push(slot);

  let banner = '';
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
    banner += decoder.decode(chunk);
    if (banner.includes('health ')) break;
  }
  const origin = /listening on (\S+)/.exec(banner)?.[1];
  const token = /access token\s+(\S+)/.exec(banner)?.[1];
  if (origin === undefined || token === undefined) {
    // The child may still be alive, and reading stderr to EOF would hang, so kill it first.
    child.kill();
    await child.exited;
    const failure = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
    throw new Error(`no banner from the instance: ${banner}${failure}`);
  }

  slot.origin = origin;
  slot.token = token;
  return slot;
}

function tempDb(): string {
  const path = join(tmpdir(), `payground-multiprocess-${process.pid}.sqlite`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  files.push(path);
  return path;
}

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Bun.nanoseconds() + timeoutMs * 1e6;
  while (Bun.nanoseconds() < deadline) {
    if (condition()) return true;
    await Bun.sleep(25);
  }
  return condition();
}

const post = (instance: Instance, path: string, body: unknown): Promise<Response> =>
  fetch(`${instance.origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${instance.token}`,
      'x-idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });

test('two processes share one database file without racing or double-delivering', async () => {
  const db = tempDb();
  // Started together: whichever wins the migration lock, both must come up.
  const [first, second] = await Promise.all([start(db), start(db)]);

  expect((await fetch(`${first.origin}/_payground/health`)).status).toBe(200);
  expect((await fetch(`${second.origin}/_payground/health`)).status).toBe(200);
  // Each instance authenticates with the sandbox it printed; both are in the same file.

  let hits = 0;
  const receiver = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      hits += 1;
      return new Response('ok');
    },
  });

  try {
    const hook = `${receiver.url.origin}/hook`;
    // Concurrent writers on both instances: the busy timeout must absorb the contention,
    // and the burst is big enough that the two drain loops overlap on the same batch.
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        post(i % 2 === 0 ? first : second, '/v1/payments', { ...PIX, notification_url: hook }),
      ),
    );
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 30 }, () => 201));
    expect(bodies.some((body) => body.includes('SQLITE_BUSY'))).toBe(false);

    expect(await until(() => hits >= 30, 10_000)).toBe(true);
    // Both instances drain once a second: several more passes must not resend anything.
    await Bun.sleep(2_500);
    expect(hits).toBe(30);

    // A signalled instance drains and exits cleanly.
    first.process.kill('SIGTERM');
    expect(await first.exited).toBe(0);
    expect((await fetch(`${second.origin}/_payground/health`)).status).toBe(200);
  } finally {
    await receiver.stop(true);
  }
}, 30_000);
