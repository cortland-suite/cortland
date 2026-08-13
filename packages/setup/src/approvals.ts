import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const APPROVALS_README = `# Approvals

When a Cortland tool wants to do something gated (send mail, delete, post)
while approvals are routed here, the request appears in this folder as a
\`pending-*.md\` file — on every device this folder syncs to.

Read the file (tap it — Quick Look is fine, no editor needed), then decide:

- **MOVE it into the \`Approve\` folder** to run the action, or into
  \`Deny\` to refuse it. On iPhone: long-press → Move.
- Or, in any text editor, check exactly ONE of the APPROVE / DENY boxes.

No decision by the deadline, deleting the file, checking both boxes, or
conflicting signals (moved to Approve with DENY checked) all count as DENY.
Decided requests land back here renamed \`approved-*\` / \`denied-*\` /
\`expired-*\` so you can always see what happened; the audit database on the
Mac records every outcome either way.

Tip for iPhone: iCloud files download on demand — if this folder looks stale,
pull down to refresh, and tap a file once to fetch it.
`;

export interface ApprovalsSetupResult {
  approvalsDir: string;
  configFile: string;
  createdReadme: boolean;
}

/**
 * Route write approvals through a folder (the remote channel): create the
 * folder + its README, and point config.json's approval key at it. Everything
 * else in config.json — live mode above all — is preserved untouched. An
 * unparseable existing config is an error, never a clobber: the wizard must
 * not destroy settings it cannot read.
 */
export function configureFolderApprovals(
  icloudRoot: string,
  dataDir: string,
  timeoutSeconds = 300
): ApprovalsSetupResult {
  const approvalsDir = path.join(icloudRoot, "Agents", "Approvals");
  fs.mkdirSync(approvalsDir, { recursive: true });
  // Pre-create the decision drop targets so they exist (and sync to the
  // phone) before the first approval ever needs them.
  fs.mkdirSync(path.join(approvalsDir, "Approve"), { recursive: true });
  fs.mkdirSync(path.join(approvalsDir, "Deny"), { recursive: true });

  const readme = path.join(approvalsDir, "README.md");
  const createdReadme = !fs.existsSync(readme);
  if (createdReadme) fs.writeFileSync(readme, APPROVALS_README);

  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = path.join(dataDir, "config.json");
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configFile)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${configFile} is not a JSON object — fix it by hand first`);
    }
    config = parsed as Record<string, unknown>;
  }
  config.approval = { channel: "folder", dir: approvalsDir, timeoutSeconds };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");

  return { approvalsDir, configFile, createdReadme };
}

/**
 * Opt-in phone ping for waiting approvals (ntfy). Mints a long random topic —
 * on the public relay the topic IS the secret, so it must be unguessable —
 * and points approval.notify at it. The ping body is a fixed string that
 * carries no information (see @cortland/governed notify.ts); the topic
 * name lives only in config.json and the user's ntfy app subscription.
 */
export function configureApprovalNotify(dataDir: string): {
  topic: string;
  url: string;
  configFile: string;
} {
  const configFile = path.join(dataDir, "config.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${configFile} is not a JSON object`);
  }
  const config = parsed as Record<string, unknown>;
  const approval = config.approval as Record<string, unknown> | undefined;
  if (!approval || approval.channel !== "folder") {
    throw new Error("configure folder approvals first — the ping belongs to that channel");
  }
  const topic = `cortland-${randomBytes(16).toString("hex")}`;
  const url = `https://ntfy.sh/${topic}`;
  approval.notify = { url };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  return { topic, url, configFile };
}
