import { createApiClient } from './client.ts';
import { readToken } from './token.ts';

export const api = createApiClient({ token: readToken });
