/**
 * The approval-waiting ping (NOTES Q19): a single POST to a user-configured
 * push topic (ntfy.sh or self-hosted) when a pending approval file is
 * written, so the human's phone says "go look" instead of the human polling
 * iCloud by hand.
 *
 * Doctrine constraints, enforced here:
 *   - The body is a FIXED STRING. No tool name, no summary, no approval id,
 *     no hostname. A push relay (especially the public ntfy server, where
 *     topics are guessable) learns nothing about the user's life beyond
 *     "something wants approval". The FILE remains the only decision surface
 *     and the only place details live.
 *   - HTTPS only, except loopback (self-hosted relays on this Mac, tests).
 *   - Fire-and-forget with a short timeout: a slow or dead relay must never
 *     delay or break the approval flow itself.
 * The caller records the egress in the audit log — every send, success or
 * failure, is a ledger row (see ConfiguredApprovalChannel).
 */

export const NOTIFY_TITLE = "Honeycrisp";
export const NOTIFY_BODY = "An approval is waiting in your Approvals folder.";
const TIMEOUT_MS = 5000;

export function notifyUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export async function notifyApprovalWaiting(
  url: string
): Promise<{ ok: boolean; detail?: string }> {
  if (!notifyUrlAllowed(url)) {
    return { ok: false, detail: "notify url must be https (or loopback http)" };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers: { Title: NOTIFY_TITLE },
      body: NOTIFY_BODY,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok
      ? { ok: true }
      : { ok: false, detail: `relay returned ${res.status}` };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 120) };
  }
}
