import { oauthStore, type NewAudit } from "./store";

export type AuditStatus = "OK" | "ERROR" | "DENIED" | "PREVIEW";

const MAX_STRING = 120;
const MAX_KEYS = 20;

/**
 * A bounded, content-free picture of tool arguments for the audit log: scalars (strings cut short),
 * array lengths instead of arrays (ids kept when short), and no question text or answer keys.
 */
export function summarizeArgs(args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>).slice(0, MAX_KEYS)) {
    if (value === null || typeof value === "boolean" || typeof value === "number") out[key] = value;
    else if (typeof value === "string") out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    else if (Array.isArray(value)) {
      const ids = value.every((v) => typeof v === "string" || typeof v === "number") && value.length <= 20;
      out[key] = ids ? value.map((v) => (typeof v === "string" ? v.slice(0, 64) : v)) : { count: value.length };
    } else out[key] = "[object]";
  }
  return out;
}

/** Never throws: a failed audit write is logged, the tool call itself is not undone. */
export async function recordMcpAudit(entry: Omit<NewAudit, "status"> & { status: AuditStatus }) {
  try {
    await oauthStore().insertAudit(entry);
  } catch (error) {
    console.error("[MCP] audit write failed", error instanceof Error ? error.message : error);
  }
}
