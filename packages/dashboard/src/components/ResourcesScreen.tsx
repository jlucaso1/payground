import type { ReactNode } from 'react';

export function ResourcesScreen({ sandboxId }: { sandboxId: string }): ReactNode {
  return <p className="text-sm text-neutral-600">Resources for sandbox {sandboxId} will be listed here.</p>;
}
