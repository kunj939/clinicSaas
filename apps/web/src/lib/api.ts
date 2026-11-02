/**
 * Thin fetch wrapper. Cookies are sent with every call (credentials: 'include') because the API
 * uses an HttpOnly session cookie; the browser never sees the session token itself.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiIssue[];

  constructor(status: number, code: string, message: string, issues: ApiIssue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function parse(response: Response) {
  if (response.status === 204) return undefined;
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function send<T>(method: Method, path: string, body?: unknown, formData?: FormData): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: formData ? undefined : { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
  };
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new ApiError(0, 'network_error', 'Network error. Check your connection and try again.');
  }
  const data = (await parse(response).catch(() => undefined)) as
    | { error?: string; message?: string; issues?: ApiIssue[] }
    | undefined;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error ?? 'request_failed',
      data?.message ?? `Request failed (${response.status})`,
      data?.issues ?? [],
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => send<T>('GET', path),
  post: <T>(path: string, body?: unknown) => send<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => send<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => send<T>('PATCH', path, body),
  delete: <T>(path: string) => send<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => send<T>('POST', path, undefined, form),
};

/** Absolute URL for opening a report in a new tab (the session cookie is sent on top-level navigation). */
export function reportFileUrl(reportId: string): string {
  return `${API_BASE}/api/reports/${reportId}/file`;
}
