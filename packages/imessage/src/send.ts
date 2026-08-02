import { execFile } from "node:child_process";

/**
 * The outbound half of the bridge: sending via Messages.app.
 *
 * There is exactly ONE recipient class in this module: the owner. No general
 * send exists anywhere in the package — messaging anyone else is not gated,
 * it is absent (docs/06, law 3's outbound mirror). The owner handle is
 * injected at construction from config, never from a tool argument, so no
 * model output can redirect a message.
 *
 * Law 4 (rate discipline) is enforced HERE, where the send happens, not in
 * the callers: a token bucket capped well below anything Apple could read
 * as automation abuse. When the bucket is empty the send fails closed —
 * the bridge goes quiet rather than bursty.
 *
 * AppleScript, not JXA: Messages' JXA bridge lost `services.whose()` on
 * current macOS (field-verified 2026-08-02, TypeError at runtime), while the
 * AppleScript form has been stable for a decade. That changes the escaping
 * rules — see `escapeAppleScript`, which is the security-critical function
 * in this file.
 */

export interface SendResult {
  ok: boolean;
  detail?: string;
}

export class OwnerSender {
  private timestamps: number[] = [];

  constructor(
    private ownerHandle: string,
    private maxPerHour = 30,
    private exec: (script: string, timeoutMs: number) => Promise<string> = runAppleScript,
    private now: () => number = Date.now
  ) {}

  remainingThisHour(): number {
    const cutoff = this.now() - 3_600_000;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    return Math.max(0, this.maxPerHour - this.timestamps.length);
  }

  async send(text: string): Promise<SendResult> {
    if (text.trim() === "") return { ok: false, detail: "empty message" };
    if (this.remainingThisHour() <= 0) {
      return { ok: false, detail: "rate-cap reached; staying quiet (law 4)" };
    }
    try {
      await this.exec(buildSendScript(this.ownerHandle, text), 60_000);
      this.timestamps.push(this.now());
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: String(err).slice(0, 200) };
    }
  }
}

/** Exposed for tests: both values enter the script only through the escaper. */
export function buildSendScript(handle: string, text: string): string {
  return `tell application "Messages"
  set svc to 1st service whose service type = iMessage
  set bud to buddy "${escapeAppleScript(handle)}" of svc
  send "${escapeAppleScript(text)}" to bud
end tell`;
}

/**
 * AppleScript string-literal escaping. AppleScript has no `\n` escape and no
 * template syntax, so the rules are: backslash and quote get escaped, control
 * characters are flattened to spaces, and real newlines become a concatenated
 * `return` — which keeps a multi-line reply inside the literal instead of
 * terminating it. Anything that would end the string early is neutralized
 * here; nothing else in this package builds Messages scripts.
 */
export function escapeAppleScript(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // every C0 control byte and DEL except newline — not just the whitespace
    // ones; none of them belong in a message and none should reach osascript
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, " ")
    .replace(/\n/g, '" & return & "');
}

function runAppleScript(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: timeoutMs }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
