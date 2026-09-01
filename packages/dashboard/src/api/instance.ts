import { createApiClient } from './client.ts';
import { markUnauthorized, readToken } from './token.ts';

export const api = createApiClient({ token: readToken, onUnauthorized: markUnauthorized });
