import { runJxa } from "@honeycrisp/governed";

/**
 * The outbound half of the bridge: AppleScript send via Messages.app.
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
    private exec: (script: string, timeoutMs: number) => Promise<string> = runJxa,
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
    const script = buildSendScript(this.ownerHandle, text);
    try {
      await this.exec(script, 60_000);
      this.timestamps.push(this.now());
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: String(err).slice(0, 200) };
    }
  }
}

/** Exposed for tests: user text enters the script only via JSON.stringify. */
export function buildSendScript(handle: string, text: string): string {
  return `
    const Messages = Application("Messages");
    const service = Messages.services.whose({ serviceType: "iMessage" })()[0];
    const buddy = service.participants.whose({ handle: ${JSON.stringify(handle)} })()[0]
      ?? Messages.participants.whose({ handle: ${JSON.stringify(handle)} })()[0];
    Messages.send(${JSON.stringify(text)}, { to: buddy });
    "sent";
  `;
}
