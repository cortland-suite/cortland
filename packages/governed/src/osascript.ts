import { execFile } from "node:child_process";

/**
 * Run a JXA (JavaScript for Automation) script via osascript. The script's return
 * value is serialized by osascript to stdout. First use against any app triggers
 * the macOS Automation permission prompt for that app — which, together with a cold
 * app launch, can take tens of seconds, so the default timeout is generous.
 */
export function runJxa(script: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed) {
            reject(
              new Error(
                `osascript timed out after ${timeoutMs}ms (a permission prompt ` +
                  `may be waiting, or the target app is slow to launch)`
              )
            );
          } else {
            reject(new Error(stderr.trim() || error.message));
          }
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}
