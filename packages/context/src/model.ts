import { spawn } from "node:child_process";
import { z } from "zod";

/**
 * Layer-1 model providers (Q21). The interface is deliberately tiny and
 * swappable; the CONFIG is where honesty lives — every provider carries an
 * explicit egress declaration that lands in the audit row of any run that
 * uses it. No config → no provider → nothing is guessed.
 */

export interface ModelProvider {
  readonly name: string;
  /** True when prompts leave this machine. */
  readonly network: boolean;
  readonly description: string;
  complete(prompt: string): Promise<string>;
}

export const ModelConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ollama"),
    model: z.string().min(1),
    url: z.string().url().default("http://127.0.0.1:11434"),
  }),
  z.object({
    type: z.literal("command"),
    run: z.array(z.string().min(1)).min(1),
    /** Defaults TRUE — assume egress unless the user declares otherwise. */
    network: z.boolean().default(true),
    description: z.string().default("user-configured command"),
  }),
]);

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export function makeProvider(config: ModelConfig | undefined): ModelProvider | null {
  if (!config) return null;
  if (config.type === "ollama") return new OllamaProvider(config.model, config.url);
  return new CommandProvider(config.run, config.network, config.description);
}

/** Local Ollama server — prompts stay on the machine. */
export class OllamaProvider implements ModelProvider {
  readonly network = false;
  readonly description: string;
  constructor(private model: string, private url: string) {
    this.description = `ollama/${model} (local)`;
  }
  get name(): string {
    return `ollama:${this.model}`;
  }
  async complete(prompt: string): Promise<string> {
    const res = await fetch(`${this.url}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`ollama: HTTP ${res.status}`);
    const data = (await res.json()) as { response?: string };
    if (typeof data.response !== "string") throw new Error("ollama: no response field");
    return data.response;
  }
}

/** Any argv command that reads a prompt on stdin and prints a completion. */
export class CommandProvider implements ModelProvider {
  constructor(
    private argv: string[],
    readonly network: boolean,
    readonly description: string
  ) {}
  get name(): string {
    return `command:${this.argv[0]}`;
  }
  complete(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.argv[0], this.argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 180_000,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => reject(new Error(`model command failed to start: ${e.message}`)));
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`model command exited ${code}: ${err.slice(0, 300)}`));
        else resolve(out.trim());
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

/** Pull a JSON array out of a model reply (tolerates code fences and prose). */
export function extractJsonArray(text: string): unknown[] {
  const stripped = text.replace(/```(?:json)?/g, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("no JSON array in model reply");
  const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("model reply is not a JSON array");
  return parsed;
}
