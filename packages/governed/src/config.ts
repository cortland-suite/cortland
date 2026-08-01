import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { notifyUrlAllowed } from "./notify.js";
import type { GovernedConfig } from "./types.js";

/**
 * Which approval channel gates live writes.
 *   "auto"   — opt-in ladder: MCP elicitation when the connected client
 *              supports it (a native Approve/Deny card in the client's own
 *              UI), else the macOS dialog. Opt-in, not the default: a client
 *              can declare the capability yet auto-decline without rendering
 *              (Claude Code, observed 2026-07-31).
 *   "elicit" — elicitation explicitly, with a declared fallback ("dialog" or
 *              "none" = deny) for clients without the capability.
 *   "dialog" — the v1 native macOS dialog (human at the Mac).
 *   "folder" — the remote file channel: requests appear in a folder (put it
 *              in iCloud Drive and any device can decide by moving the file).
 *   "invalid" is a parse result, never a configuration: it means the config
 *   ASKED for something unrecognized, and the gate must deny rather than guess.
 */
export type ApprovalChannelSpec =
  | { channel: "auto"; timeoutSeconds?: number }
  | { channel: "elicit"; fallback: "dialog" | "none"; timeoutSeconds?: number }
  | { channel: "dialog" }
  | {
      channel: "folder";
      dir: string;
      timeoutSeconds?: number;
      pollSeconds?: number;
      /** Optional push-relay URL pinged when a request lands (see notify.ts).
       *  A malformed notify block disables the ping, never the channel. */
      notifyUrl?: string;
    }
  | { channel: "invalid"; reason: string };

export function defaultDataDir(appName: string): string {
  return path.join(os.homedir(), "Library", "Application Support", appName);
}

/**
 * Live mode is opt-in and every failure path resolves to dry-run:
 *   - env GOVERNED_LIVE: exactly "1" or "true" enables; any other value disables
 *     (even "TRUE", "yes" — a value that isn't the documented opt-in is an error,
 *     and errors fail toward dry-run);
 *   - else config.json in the data dir: { "live": true } — strict boolean true only;
 *   - missing file, unreadable file, invalid JSON, wrong type: dry-run.
 */
export function loadConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
): GovernedConfig {
  try {
    const envLive = env.GOVERNED_LIVE;
    if (envLive !== undefined) {
      return { live: envLive === "1" || envLive === "true" };
    }
    const file = path.join(dataDir, "config.json");
    if (!fs.existsSync(file)) return { live: false };
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { live: false };
    return { live: (parsed as { live?: unknown }).live === true };
  } catch {
    return { live: false };
  }
}

/**
 * Approval-channel selection, from the same config.json:
 *   { "live": true, "approval": { "channel": "folder", "dir": "~/…/Approvals" } }
 *
 * Failure posture: a MISSING or unparseable config means "dialog" — the one
 * channel proven to put a prompt in front of a human on every Mac (field
 * finding 2026-07-31: a client can DECLARE the elicitation capability yet
 * auto-decline the request without rendering anything, which would make an
 * "auto" default silently unusable; auto stays available as an explicit
 * opt-in). A broken config also means live=false, so no gate is consulted
 * at all. But a config that names
 * an unknown channel, or names "folder" without a usable dir, parses to
 * "invalid": the human asked for something we can't honor, and guessing which
 * channel they meant would move the decision surface without their knowledge.
 * Invalid ALWAYS denies.
 */
export function loadApprovalConfig(dataDir: string): ApprovalChannelSpec {
  let parsed: unknown;
  try {
    const file = path.join(dataDir, "config.json");
    if (!fs.existsSync(file)) return { channel: "dialog" };
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { channel: "dialog" };
  }
  if (typeof parsed !== "object" || parsed === null) return { channel: "dialog" };
  const approval = (parsed as { approval?: unknown }).approval;
  if (approval === undefined) return { channel: "dialog" };
  if (typeof approval !== "object" || approval === null) {
    return { channel: "invalid", reason: "approval must be an object" };
  }
  const a = approval as Record<string, unknown>;
  if (a.channel === "auto") {
    return {
      channel: "auto",
      timeoutSeconds: typeof a.timeoutSeconds === "number" ? a.timeoutSeconds : undefined,
    };
  }
  if (a.channel === "elicit") {
    return {
      channel: "elicit",
      // an explicit elicit config with no stated fallback denies when the
      // client can't elicit — the human named ONE surface, honor exactly it
      fallback: a.fallback === "dialog" ? "dialog" : "none",
      timeoutSeconds: typeof a.timeoutSeconds === "number" ? a.timeoutSeconds : undefined,
    };
  }
  if (a.channel === "dialog") return { channel: "dialog" };
  if (a.channel === "folder") {
    if (typeof a.dir !== "string" || a.dir.trim() === "") {
      return { channel: "invalid", reason: 'approval.channel "folder" requires a dir' };
    }
    const dir = a.dir.startsWith("~/")
      ? path.join(os.homedir(), a.dir.slice(2))
      : a.dir;
    const notify = a.notify as { url?: unknown } | undefined;
    const notifyUrl =
      typeof notify === "object" &&
      notify !== null &&
      typeof notify.url === "string" &&
      notifyUrlAllowed(notify.url)
        ? notify.url
        : undefined;
    return {
      channel: "folder",
      dir,
      timeoutSeconds: typeof a.timeoutSeconds === "number" ? a.timeoutSeconds : undefined,
      pollSeconds: typeof a.pollSeconds === "number" ? a.pollSeconds : undefined,
      notifyUrl,
    };
  }
  return {
    channel: "invalid",
    reason: `unknown approval.channel ${JSON.stringify(a.channel)}`,
  };
}
