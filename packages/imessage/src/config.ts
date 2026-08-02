import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Bridge configuration, from the suite's config.json under an `imessage` key:
 *
 *   "imessage": {
 *     "ownerHandles": ["+15551230000", "you@icloud.com"],
 *     "model": { "type": "ollama", "model": "gemma4:e4b" },
 *     "maxPerHour": 30,
 *     "pollSeconds": 3,
 *     "approvalTimeoutSeconds": 300
 *   }
 *
 * Fail-closed posture: NO ownerHandles means the bridge refuses to start.
 * There is no "any sender" mode and no default handle — an unconfigured
 * bridge that answered everyone would be the worst possible failure, so it
 * is unreachable by construction rather than discouraged in docs.
 */

export interface BridgeConfig {
  ownerHandles: string[];
  /** The assistant account's handle (its Apple ID / phone as Messages stores
   *  it). Pins reads to messages addressed TO the assistant — law 3 made
   *  structural. Optional only for back-compat; setup always writes it. */
  assistantAccount?: string;
  model: { type: "ollama"; model: string; host: string };
  maxPerHour: number;
  pollSeconds: number;
  approvalTimeoutSeconds: number;
}

export const DEFAULT_CHAT_DB = path.join(
  os.homedir(),
  "Library",
  "Messages",
  "chat.db"
);

export function loadBridgeConfig(dataDir: string): BridgeConfig {
  const file = path.join(dataDir, "config.json");
  if (!fs.existsSync(file)) {
    throw new Error(`no config at ${file} — run: honeycrisp-imessage setup --owner <handle>`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const block = (parsed as { imessage?: unknown })?.imessage;
  if (typeof block !== "object" || block === null) {
    throw new Error(`config.json has no "imessage" block — run: honeycrisp-imessage setup --owner <handle>`);
  }
  const b = block as Record<string, unknown>;
  const handles = Array.isArray(b.ownerHandles)
    ? b.ownerHandles.filter((h): h is string => typeof h === "string" && h.trim() !== "")
    : [];
  if (handles.length === 0) {
    throw new Error(
      "imessage.ownerHandles is empty — the bridge refuses to run without an owner allowlist"
    );
  }
  const model = (b.model ?? {}) as Record<string, unknown>;
  return {
    ownerHandles: handles.map((h) => h.trim()),
    assistantAccount:
      typeof b.assistantAccount === "string" && b.assistantAccount.trim() !== ""
        ? b.assistantAccount.trim()
        : undefined,
    model: {
      type: "ollama",
      model: typeof model.model === "string" ? model.model : "gemma4:e4b",
      host: typeof model.host === "string" ? model.host : "http://127.0.0.1:11434",
    },
    maxPerHour: intOr(b.maxPerHour, 30, 1, 120),
    pollSeconds: intOr(b.pollSeconds, 3, 1, 60),
    approvalTimeoutSeconds: intOr(b.approvalTimeoutSeconds, 300, 30, 3600),
  };
}

/** Write/merge the imessage block, preserving everything else in config.json. */
export function saveBridgeConfig(
  dataDir: string,
  patch: { ownerHandles?: string[]; model?: string; assistantAccount?: string }
): BridgeConfig {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "config.json");
  let config: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${file} is not a JSON object — fix it by hand first`);
    }
    config = parsed as Record<string, unknown>;
  }
  const existing = (config.imessage ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...existing };
  if (patch.ownerHandles) next.ownerHandles = patch.ownerHandles;
  if (patch.model) next.model = { type: "ollama", model: patch.model };
  if (patch.assistantAccount) next.assistantAccount = patch.assistantAccount;
  config.imessage = next;
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return loadBridgeConfig(dataDir);
}

function intOr(value: unknown, fallback: number, lo: number, hi: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(hi, Math.max(lo, Math.floor(value)))
    : fallback;
}
