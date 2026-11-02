/** Expected, user-facing failure. The error handler turns it into a JSON response with `error` as the code. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message?: string) {
    super(message ?? code);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const errors = {
  unauthorized: () => new AppError(401, 'unauthorized', 'Please sign in'),
  forbidden: () => new AppError(403, 'forbidden', 'You do not have permission for this action'),
  notFound: (what = 'resource') => new AppError(404, 'not_found', `${what} not found`),
  conflict: (code: string, message?: string) => new AppError(409, code, message),
  onboardingRequired: () => new AppError(409, 'onboarding_required', 'Create your clinic first'),
  validation: (message: string) => new AppError(400, 'validation_failed', message),
};

/** Postgres error code for unique/exclusion violations. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isPgError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * Readable text for logs and the CLI. Node reports failed connections to `localhost` as an
 * AggregateError with an empty message, so the codes of the inner errors are added.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const codes = [...new Set(error.errors.map((inner) => (inner as { code?: unknown }).code).filter(Boolean))];
    const label = error.message || error.name;
    return codes.length ? `${label}: ${codes.join(', ')}` : label;
  }
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
