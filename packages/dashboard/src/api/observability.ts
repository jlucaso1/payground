import { createObservabilityClient } from './client-observability.ts';
import { readToken } from './token.ts';

export const observability = createObservabilityClient({ token: readToken });
