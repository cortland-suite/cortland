import { createHash } from "node:crypto";

export interface RedactedField {
  redacted: true;
  length: number;
  sha256: string;
}

/**
 * Replace the values of declared-sensitive keys with { length, sha256 }. The audit
 * row stays useful ("body: 1.2KB") without becoming a second copy of the content.
 * The hash lets a later investigation confirm WHAT was sent without storing it.
 */
export function redactArgs(
  args: Record<string, unknown>,
  redactKeys: string[] | undefined
): Record<string, unknown> {
  if (!redactKeys || redactKeys.length === 0) return { ...args };
  const out: Record<string, unknown> = { ...args };
  for (const key of redactKeys) {
    if (!(key in out) || out[key] === undefined) continue;
    const serialized =
      typeof out[key] === "string" ? (out[key] as string) : JSON.stringify(out[key]);
    const field: RedactedField = {
      redacted: true,
      length: Buffer.byteLength(serialized, "utf8"),
      sha256: createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 16),
    };
    out[key] = field;
  }
  return out;
}
