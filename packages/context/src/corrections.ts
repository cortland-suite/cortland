import fs from "node:fs";
import path from "node:path";
import type { ContextStore } from "./store.js";

/**
 * The flywheel's intake (M4). The briefing file is the feedback form: items
 * carry stable ids in HTML comments (invisible when rendered); ticking an
 * item's checkbox from any device means "mute this". A free-text
 * "## Corrections" section takes notes ("missed: ..."). Parsed on every brief
 * run; judgments land in the human layer, idempotent per (target, file).
 */

export interface Correction {
  target: string;
  verdict: "mute" | "note";
  detail?: string;
}

const CHECKED_ITEM = /^[-*] \[[xX]\] .*<!-- id:([^ >]+) -->/;

export function parseBriefingCorrections(markdown: string): Correction[] {
  const corrections: Correction[] = [];
  let inCorrections = false;
  for (const line of markdown.split("\n")) {
    if (/^## /.test(line)) inCorrections = /^## Corrections/i.test(line);
    const checked = CHECKED_ITEM.exec(line);
    if (checked) {
      corrections.push({ target: checked[1], verdict: "mute" });
      continue;
    }
    if (inCorrections) {
      const note = /^[-*] (.+)$/.exec(line.trim());
      if (note && !CHECKED_ITEM.test(line)) {
        corrections.push({ target: `note:${hashText(note[1])}`, verdict: "note", detail: note[1] });
      }
    }
  }
  return corrections;
}

/** Scan briefing files in a folder and ingest their corrections. */
export function ingestCorrections(
  store: ContextStore,
  dir: string,
  log: (message: string) => void
): number {
  if (!fs.existsSync(dir)) return 0;
  let ingested = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const markdown = fs.readFileSync(path.join(dir, name), "utf8");
    for (const correction of parseBriefingCorrections(markdown)) {
      const isNew = store.addJudgment({
        target: correction.target,
        verdict: correction.verdict,
        detail: correction.detail,
        sourceFile: name,
      });
      if (isNew) ingested += 1;
    }
  }
  if (ingested > 0) log(`corrections: ${ingested} new judgment(s) ingested`);
  return ingested;
}

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
