import { createDocumentsClient } from './client-documents.ts';
import { readToken } from './token.ts';

export const documentsApi = createDocumentsClient({ token: readToken });
