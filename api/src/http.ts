// A tiny request/response shape that is not tied to any host.
//
// Handlers are pure functions from ApiRequest to ApiResponse, so the same code
// runs behind the local dev server and behind Azure Functions with only a thin
// adapter at each edge. It also means a handler can be tested by calling it,
// with no HTTP involved.

export type ApiRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  cookies: Record<string, string>;
  body: unknown;
};

export type SetCookie = {
  name: string;
  value: string;
  maxAgeSeconds?: number;
  /** Only ever unset for the delete case. */
  expires?: Date;
};

export type ApiResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  setCookies?: SetCookie[];
};

/**
 * Errors that are safe to show a clinician. `message` is user-facing copy in
 * the app's voice, not a stack trace — anything unexpected becomes a generic
 * 500 in `runHandler` instead.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (code: string, message: string) => new ApiError(400, code, message);
export const unauthorized = (message: string) => new ApiError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message: string) => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);

export function json(body: unknown, init: Omit<ApiResponse, 'body' | 'status'> & { status?: number } = {}): ApiResponse {
  return { status: init.status ?? 200, body, ...init };
}

export function noContent(init: Omit<ApiResponse, 'body' | 'status'> = {}): ApiResponse {
  return { status: 204, ...init };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * `SameSite=Strict` and `HttpOnly` are affordable only because the API is
 * same-origin with the SPA (Static Web Apps serves both). Splitting the origin
 * would cost all of this plus CORS plus sendBeacon.
 */
export function serialiseCookie(cookie: SetCookie, secure: boolean): string {
  const parts = [`${cookie.name}=${encodeURIComponent(cookie.value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  if (cookie.expires) parts.push(`Expires=${cookie.expires.toUTCString()}`);
  else if (cookie.maxAgeSeconds !== undefined) parts.push(`Max-Age=${cookie.maxAgeSeconds}`);
  return parts.join('; ');
}

export type Handler = (request: ApiRequest) => Promise<ApiResponse>;

/**
 * Turn a thrown error into a response. Known ApiErrors keep their message
 * because it was written for a clinician to read; anything else is logged and
 * flattened, so an internal detail never reaches the browser.
 */
export async function runHandler(handler: Handler, request: ApiRequest): Promise<ApiResponse> {
  try {
    return await handler(request);
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        status: error.status,
        body: { error: { code: error.code, message: error.message } },
      };
    }
    console.error(`[api] ${request.method} ${request.path} failed:`, error);
    return {
      status: 500,
      body: {
        error: {
          code: 'INTERNAL',
          message: "Something went wrong on our side. Your work is saved locally — try again in a moment.",
        },
      },
    };
  }
}

/** Body parsing that rejects the wrong shape instead of trusting it. */
export function requireObject(body: unknown, what: string): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('BAD_BODY', `Expected ${what}.`);
  }
  return body as Record<string, unknown>;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('BAD_FIELD', `"${field}" is required.`);
  }
  return value;
}
