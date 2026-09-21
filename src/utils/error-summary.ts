/**
 * A compact, log-safe view of an error. HTTP client errors (gaxios, used by Google's libraries)
 * carry the whole request config and response, which floods logs and can include headers.
 */
export function summarizeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const { status, code } = error as { status?: unknown; code?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  };
}
