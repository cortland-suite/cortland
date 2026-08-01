import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AuditStore } from "@honeycrisp/governed";
import {
  substitutePlaceholders,
  type PipelineConfig,
  type PipelineStep,
} from "./config.js";
import { describeInput, errorPath, resultPath } from "./results.js";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface RunnerDeps {
  audit: AuditStore;
  version: string;
  log: (message: string) => void;
}

export interface RunOutcome {
  ok: boolean;
  outputFile: string;
}

/**
 * Run a pipeline for one dropped file. Steps run sequentially as argv arrays
 * (no shell); each step receives the previous step's stdout on stdin, and the
 * last step's stdout becomes the result file. Failure writes an error file in
 * plain English beside the drop — silence is never the failure mode. Every run
 * leaves an audit row, success or not.
 */
export async function runPipeline(
  cfg: PipelineConfig,
  dir: string,
  inputPath: string,
  deps: RunnerDeps
): Promise<RunOutcome> {
  const inputName = describeInput(inputPath);
  const provenance = `created by honeycrisp-folders v${deps.version}, pipeline "${cfg.name}"`;
  const auditBase = {
    tool: `pipeline_${cfg.name}`,
    scope: dir,
    mode: "write-safe" as const,
    undo: "none" as const,
    args: {
      input: inputName,
      steps: cfg.steps.map((s) => s.name),
      network: cfg.steps.some((s) => s.network),
    },
    dryRun: false,
    toolVersion: deps.version,
  };

  let carry = "";
  for (const step of cfg.steps) {
    try {
      carry = await runStep(step, dir, inputPath, carry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const file = errorPath(inputPath);
      fs.writeFileSync(
        file,
        [
          `# Pipeline failed: ${inputName}`,
          ``,
          `Pipeline "${cfg.name}" failed at step "${step.name}".`,
          ``,
          "```",
          message.slice(0, 4000),
          "```",
          ``,
          `Fix the input (or the step in ${path.join(dir, ".pipeline.yaml")}) and drop the file again.`,
          ``,
          `<!-- ${provenance} -->`,
        ].join("\n")
      );
      deps.audit.record({
        ...auditBase,
        outcome: "error",
        detail: `step "${step.name}": ${message.slice(0, 500)}`,
      });
      deps.log(`✗ ${cfg.name}: ${inputName} failed at "${step.name}"`);
      return { ok: false, outputFile: file };
    }
  }

  const file = resultPath(inputPath);
  fs.writeFileSync(
    file,
    [`# Result: ${inputName}`, ``, `<!-- ${provenance} -->`, ``, carry].join("\n")
  );
  deps.audit.record({ ...auditBase, outcome: "ok" });
  deps.log(`✓ ${cfg.name}: ${inputName} → ${path.basename(file)}`);
  return { ok: true, outputFile: file };
}

function runStep(
  step: PipelineStep,
  dir: string,
  inputPath: string,
  stdinText: string
): Promise<string> {
  const argv = substitutePlaceholders(step.run, inputPath, dir);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: dir,
      timeout: step.timeoutSeconds * 1000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      if (out.length < MAX_OUTPUT_BYTES) out += d;
    });
    child.stderr.on("data", (d) => {
      if (err.length < 65_536) err += d;
    });
    child.on("error", (e) => reject(new Error(`could not start "${argv[0]}": ${e.message}`)));
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`"${argv[0]}" timed out after ${step.timeoutSeconds}s (${signal})`));
      } else if (code !== 0) {
        reject(new Error(`"${argv.join(" ")}" exited ${code}\n${err.trim()}`));
      } else {
        resolve(out);
      }
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}
