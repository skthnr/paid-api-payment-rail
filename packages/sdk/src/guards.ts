/**
 * Canonical runtime guard for untrusted JSON shapes in the SDK.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
