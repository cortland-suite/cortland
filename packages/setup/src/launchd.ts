import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LAUNCHD_LABEL = "com.honeycrisp.folders";

export function launchAgentPath(label: string = LAUNCHD_LABEL): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/** Substitute REPLACE_* placeholders (XML-escaped); refuse partial renders. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(key, escapeXml(value));
  }
  if (rendered.includes("REPLACE_")) {
    throw new Error("plist template still contains placeholders after rendering");
  }
  return rendered;
}

export function renderPlist(
  template: string,
  nodePath: string,
  cliPath: string,
  watchRoot: string
): string {
  return renderTemplate(template, {
    REPLACE_NODE_PATH: nodePath,
    REPLACE_CLI_PATH: cliPath,
    REPLACE_WATCH_ROOT: watchRoot,
  });
}

export function installPlist(rendered: string, label: string = LAUNCHD_LABEL): string {
  const target = launchAgentPath(label);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered);
  return target;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
