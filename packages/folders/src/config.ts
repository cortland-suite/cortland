import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const PIPELINE_FILE = ".pipeline.yaml";

const StepSchema = z.object({
  name: z.string().min(1),
  /**
   * Command as an argv array — never a shell string, so file names and config
   * values can't be interpreted as shell syntax. Placeholders: {input} = the
   * dropped file's absolute path, {dir} = the pipeline folder.
   */
  run: z.array(z.string().min(1)).min(1),
  /**
   * Declared, not enforced (v1): a step that talks to the network must say so.
   * The declaration lands in the audit row and in the folder's own contract —
   * inspectable before anything is dropped in.
   */
  network: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(1).max(3600).default(120),
});

export const PipelineSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/, "lowercase letters, digits, - and _ only"),
  description: z.string().optional(),
  steps: z.array(StepSchema).min(1),
});

export type PipelineStep = z.infer<typeof StepSchema>;
export type PipelineConfig = z.infer<typeof PipelineSchema>;

export function parsePipelineYaml(text: string): PipelineConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`invalid YAML: ${String(err instanceof Error ? err.message : err)}`);
  }
  const result = PipelineSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `invalid pipeline config at "${issue.path.join(".") || "(root)"}": ${issue.message}`
    );
  }
  return result.data;
}

export function substitutePlaceholders(
  args: string[],
  inputPath: string,
  dir: string
): string[] {
  return args.map((a) => a.replaceAll("{input}", inputPath).replaceAll("{dir}", dir));
}
