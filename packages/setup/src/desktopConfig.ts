import fs from "node:fs";

export interface DesktopConfig {
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  [key: string]: unknown;
}

export function readDesktopConfig(file: string): DesktopConfig {
  if (!fs.existsSync(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${file} is not a JSON object`);
  }
  return parsed as DesktopConfig;
}

export function hasServer(config: DesktopConfig, name: string): boolean {
  return Boolean(config.mcpServers && name in config.mcpServers);
}

/** Pure merge — existing servers and unknown keys are preserved untouched. */
export function withServer(
  config: DesktopConfig,
  name: string,
  command: string,
  args: string[]
): DesktopConfig {
  return {
    ...config,
    mcpServers: { ...(config.mcpServers ?? {}), [name]: { command, args } },
  };
}

/** Write with a timestamped backup of any existing file beside it. */
export function writeDesktopConfig(file: string, config: DesktopConfig): string | null {
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return backup;
}
