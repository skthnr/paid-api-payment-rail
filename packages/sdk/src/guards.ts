/**
 * Canonical runtime guard for untrusted JSON shapes in the SDK.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Human-readable message for an unknown rejection value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
