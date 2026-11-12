/**
 * Canonical runtime guard for untrusted JSON objects.
 *
 * Express bodies, header payloads and RPC results all cross this boundary;
 * field-level checks stay at the call site.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
