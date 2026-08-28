import type { Clock } from '@payground/core';

export const VERSION = '0.1.0';

export interface Health {
  status: 'ok';
  version: string;
  uptime_ms: number;
}

export function health(clock: Clock, startedAt: number): Health {
  return { status: 'ok', version: VERSION, uptime_ms: clock.now() - startedAt };
}
