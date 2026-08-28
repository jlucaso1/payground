export interface ErrorCause {
  code: string | number;
  description: string;
  data?: string | null;
}

export interface ErrorBody {
  message: string;
  error: string;
  status: number;
  cause: ErrorCause[];
}

export function errorBody(
  status: number,
  error: string,
  message: string,
  cause: ErrorCause[] = [],
): ErrorBody {
  return { message, error, status, cause };
}

export const badRequest = (message: string, cause: ErrorCause[] = []): ErrorBody =>
  errorBody(400, 'bad_request', message, cause);

export const unauthorized = (message = 'invalid access token'): ErrorBody =>
  errorBody(401, 'unauthorized', message, [{ code: 2001, description: message }]);

export const forbidden = (message: string): ErrorBody => errorBody(403, 'forbidden', message);

export const notFound = (message = 'Payment not found'): ErrorBody =>
  errorBody(404, 'not_found', message);

export const conflict = (message: string): ErrorBody => errorBody(409, 'conflict', message);

export const unprocessable = (message: string, cause: ErrorCause[] = []): ErrorBody =>
  errorBody(422, 'unprocessable_entity', message, cause);

export const tooManyRequests = (message = 'too many requests'): ErrorBody =>
  errorBody(429, 'too_many_requests', message);

export const serverError = (message = 'internal error'): ErrorBody =>
  errorBody(500, 'internal_server_error', message);

export const errorResponse = (body: ErrorBody): Response =>
  Response.json(body, { status: body.status });
