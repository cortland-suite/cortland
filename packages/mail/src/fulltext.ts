import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tier 2 search (NOTES Q6): Spotlight full-text over Mail's message store.
 * Requires Full Disk Access — and CRITICALLY, without it Spotlight does not
 * error, it silently returns zero mail results. So this module's first duty is
 * to distinguish "no permission" from "no matches" and say so out loud.
 */

export const MAIL_DIR = path.join(os.homedir(), "Library", "Mail");

export function hasFullDiskAccess(dir: string = MAIL_DIR): boolean {
  try {
    fs.readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

export const FDA_INSTRUCTIONS =
  "Full-text search requires Full Disk Access for this server's process " +
  "(the node binary running it). Grant it in System Settings → Privacy & " +
  "Security → Full Disk Access, restart the server, and retry. Header search " +
  "(mail_search) works without it. Note: without this permission Spotlight " +
  "would silently return zero mail results — this tool refuses instead.";

/**
 * Build the Spotlight metadata query. The search text is embedded in a quoted
 * mdquery string literal; backslashes and quotes are escaped so the text cannot
 * terminate the literal. (Spotlight treats * as a wildcard inside the phrase —
 * documented behavior, not an injection risk.)
 */
export function buildMdfindQuery(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `kMDItemTextContent == "*${escaped}*"cd`;
}

export function runMdfind(
  query: string,
  dir: string = MAIL_DIR,
  timeoutMs = 30_000
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "mdfind",
      ["-onlyin", dir, query],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else
          resolve(
            stdout
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.endsWith(".emlx"))
          );
      }
    );
  });
}

export interface EmlxHeaders {
  messageId?: string;
  subject?: string;
  from?: string;
  date?: string;
  path: string;
}

/**
 * Minimal .emlx header parse: the file is a byte-count line, then RFC 822, then
 * a plist. We only need the top headers. Folded (indented continuation) lines
 * are unfolded; MIME encoded-words are left as-is (v1).
 */
export function parseEmlxHeaders(content: string, filePath: string): EmlxHeaders {
  const lines = content.split(/\r?\n/);
  const headerLines: string[] = [];
  // First line is the emlx byte count — skip it.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") break;
    if (/^[ \t]/.test(line) && headerLines.length > 0) {
      headerLines[headerLines.length - 1] += " " + line.trim();
    } else {
      headerLines.push(line);
    }
  }
  const get = (name: string): string | undefined => {
    const prefix = name.toLowerCase() + ":";
    const hit = headerLines.find((l) => l.toLowerCase().startsWith(prefix));
    return hit?.slice(prefix.length).trim();
  };
  return {
    messageId: get("message-id")?.replace(/^<|>$/g, ""),
    subject: get("subject"),
    from: get("from"),
    date: get("date"),
    path: filePath,
  };
}

export interface FulltextHit {
  messageId?: string;
  subject?: string;
  from?: string;
  date?: string;
  mailboxPath: string;
}

export async function searchFulltext(
  text: string,
  limit: number,
  dir: string = MAIL_DIR
): Promise<{ totalFiles: number; hits: FulltextHit[] }> {
  const paths = await runMdfind(buildMdfindQuery(text), dir);
  const hits: FulltextHit[] = [];
  for (const p of paths.slice(0, limit)) {
    let headers: EmlxHeaders;
    try {
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(16_384);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      headers = parseEmlxHeaders(buf.subarray(0, read).toString("utf8"), p);
    } catch {
      headers = { path: p };
    }
    hits.push({
      messageId: headers.messageId,
      subject: headers.subject,
      from: headers.from,
      date: headers.date,
      mailboxPath: path.relative(dir, p),
    });
  }
  return { totalFiles: paths.length, hits };
}
