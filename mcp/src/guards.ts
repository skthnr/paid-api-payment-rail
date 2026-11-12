/**
 * Canonical runtime guards shared by the MCP server modules.
 *
 * Untrusted JSON arrives from stdin and from facilitator responses; both are
 * narrowed here once instead of recreating an ad-hoc check per call site.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
