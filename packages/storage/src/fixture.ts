import { type Sandbox, type SandboxId, sandboxId } from '@payground/core';
import { Storage } from './index.ts';

export function sandbox(id: string, createdAt = 1_000): Sandbox {
  return {
    id: sandboxId(id),
    name: id,
    accessToken: `TEST-${id}-access`,
    publicKey: `TEST-${id}-public`,
    webhookSecret: `secret-${id}`,
    liveMode: false,
    createdAt,
  };
}

export function storageWith(...ids: string[]): { storage: Storage; ids: SandboxId[] } {
  const storage = Storage.open();
  const created = ids.map((id) => {
    const s = sandbox(id);
    storage.sandboxes.create(s);
    return s.id;
  });
  return { storage, ids: created };
}
