import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PINS, rawUrl } from './pin.ts';

const SPEC_DIR = join(import.meta.dir, '../../../spec');

const digest = (bytes: ArrayBuffer): string =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

async function main(): Promise<void> {
  const lock: Record<string, string> = {};

  for (const file of PINS.openapi.files) {
    const url = rawUrl(PINS.openapi.repo, PINS.openapi.commit, file);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    const bytes = await res.arrayBuffer();
    const target = join(SPEC_DIR, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, new Uint8Array(bytes));
    lock[file] = digest(bytes);
    console.log(`${file} ${lock[file]}`);
  }

  await writeFile(
    join(SPEC_DIR, 'spec.lock.json'),
    `${JSON.stringify({ repo: PINS.openapi.repo, commit: PINS.openapi.commit, sha256: lock }, null, 2)}\n`,
  );
}

await main();
