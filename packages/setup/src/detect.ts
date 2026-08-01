import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Locate a file inside a sibling @honeycrisp package via module resolution.
 * Works in both layouts — the monorepo (workspaces symlink node_modules/
 * @honeycrisp/* to packages/*) and the npm-installed tree — because both are
 * just node_modules to the resolver. A package that isn't installed resolves
 * to "", which fails every fs.existsSync check downstream (the wizard already
 * treats missing packages as "skip that section").
 */
function pkgFile(pkg: string, rel: string): string {
  try {
    return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), rel);
  } catch {
    return "";
  }
}

export function suitePaths() {
  return {
    mailServer: pkgFile("@honeycrisp/mail", "dist/server.js"),
    foldersCli: pkgFile("@honeycrisp/folders", "dist/cli.js"),
    contextCli: pkgFile("@honeycrisp/context", "dist/cli.js"),
    launchdTemplate: pkgFile(
      "@honeycrisp/folders",
      "launchd/com.honeycrisp.folders.plist.example"
    ),
    contextCaptureTemplate: pkgFile(
      "@honeycrisp/context",
      "launchd/com.honeycrisp.context-capture.plist.example"
    ),
    contextBriefTemplate: pkgFile(
      "@honeycrisp/context",
      "launchd/com.honeycrisp.context-brief.plist.example"
    ),
  };
}

export function icloudDrivePath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs"
  );
}

export function claudeDesktopConfigPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json"
  );
}

export function hasFullDiskAccess(): boolean {
  try {
    fs.readdirSync(path.join(os.homedir(), "Library", "Mail"));
    return true;
  } catch {
    return false;
  }
}

export function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/which", [cmd], (error) => resolve(!error));
  });
}

export function run(
  cmd: string,
  args: string[],
  timeoutMs = 120_000
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: (stdout + stderr).trim(),
      });
    });
  });
}
