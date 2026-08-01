import chokidar, { type FSWatcher } from "chokidar";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parsePipelineYaml, PIPELINE_FILE, type PipelineConfig } from "./config.js";
import { icloudPlaceholderTarget, resultPath, errorPath, shouldIgnore } from "./results.js";
import { runPipeline, type RunnerDeps } from "./runner.js";

/** Preload every .pipeline.yaml under root so data files seen during the
 * initial scan can't race their own pipeline definition. */
export function discoverPipelines(
  root: string,
  log: (m: string) => void
): Map<string, PipelineConfig> {
  const found = new Map<string, PipelineConfig>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === PIPELINE_FILE) {
        try {
          found.set(dir, parsePipelineYaml(fs.readFileSync(full, "utf8")));
        } catch (err) {
          log(`invalid ${full}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  };
  walk(root);
  return found;
}

/** Skip inputs whose result/error file is already newer than the input. */
export function alreadyProcessed(inputPath: string): boolean {
  let inputMtime: number;
  try {
    inputMtime = fs.statSync(inputPath).mtimeMs;
  } catch {
    return true; // vanished
  }
  for (const candidate of [resultPath(inputPath), errorPath(inputPath)]) {
    try {
      if (fs.statSync(candidate).mtimeMs >= inputMtime) return true;
    } catch {
      /* not processed yet */
    }
  }
  return false;
}

export function watchRoot(root: string, deps: RunnerDeps): FSWatcher {
  const pipelines = discoverPipelines(root, deps.log);
  for (const dir of pipelines.keys()) deps.log(`pipeline ready: ${dir}`);
  const inFlight = new Set<string>();

  const watcher = chokidar.watch(root, {
    // iCloud sync writes arrive in bursts; wait for the file to hold still.
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
  });

  const handle = async (filePath: string) => {
    const base = path.basename(filePath);
    const dir = path.dirname(filePath);

    if (base === PIPELINE_FILE) {
      try {
        pipelines.set(dir, parsePipelineYaml(fs.readFileSync(filePath, "utf8")));
        deps.log(`pipeline loaded: ${dir}`);
      } catch (err) {
        pipelines.delete(dir);
        deps.log(`invalid ${filePath}: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    // Dataless iCloud placeholder: ask for the download; the real file's
    // arrival will trigger its own add event.
    const target = icloudPlaceholderTarget(base);
    if (target && pipelines.has(dir)) {
      execFile("brctl", ["download", path.join(dir, target)], () => {});
      deps.log(`downloading dataless file: ${target}`);
      return;
    }

    if (shouldIgnore(base)) return;
    const cfg = pipelines.get(dir);
    if (!cfg) return;
    if (inFlight.has(filePath) || alreadyProcessed(filePath)) return;

    inFlight.add(filePath);
    try {
      await runPipeline(cfg, dir, filePath, deps);
    } finally {
      inFlight.delete(filePath);
    }
  };

  watcher.on("add", handle);
  watcher.on("change", handle);
  return watcher;
}
