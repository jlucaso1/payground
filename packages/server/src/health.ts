import type { Clock } from '@payground/core';
// The CLI manifest is the single source of truth for the released version. The import
// is inlined by the bundler, so the server keeps no runtime dependency on the file.
import pkg from '../../cli/package.json' with { type: 'json' };

export const VERSION: string = pkg.version;

export interface Health {
  status: 'ok';
  version: string;
  uptime_ms: number;
}

export function health(clock: Clock, startedAt: number): Health {
  return { status: 'ok', version: VERSION, uptime_ms: clock.now() - startedAt };
}
