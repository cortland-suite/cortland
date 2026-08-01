import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditStore } from "./audit.js";
import { ElicitationApprovalChannel } from "./approvalElicit.js";
import { ConfiguredApprovalChannel } from "./approvalSelect.js";
import { defaultDataDir, loadConfig } from "./config.js";
import { executeGoverned, type ExecutionDeps } from "./execute.js";
import { assertCleanArgv } from "./hygiene.js";
import type { ApprovalChannel, GovernedToolDef } from "./types.js";

export interface GovernedServerOptions {
  name: string;
  version: string;
  /** Storage dir name under ~/Library/Application Support. Defaults to `name`. */
  appName?: string;
  /** Override the storage dir entirely (tests). */
  dataDir?: string;
  tools: Array<Readonly<GovernedToolDef<any>>>;
  /** Override the approval channel (tests, future elicitation upgrade). */
  approval?: ApprovalChannel;
  /** Argv to hygiene-check. Defaults to process.argv. */
  argv?: string[];
  /** Identity annotation stamped into every audit row (remote gateway). */
  principal?: string;
}

export interface GovernedServer {
  server: McpServer;
  audit: AuditStore;
  connectStdio(): Promise<void>;
}

export function createGovernedServer(opts: GovernedServerOptions): GovernedServer {
  assertCleanArgv(opts.argv ?? process.argv);

  const dataDir = opts.dataDir ?? defaultDataDir(opts.appName ?? opts.name);
  const audit = new AuditStore(dataDir);
  const server = new McpServer({ name: opts.name, version: opts.version });
  // Bound lazily: client capabilities exist only after a client connects.
  const elicit = new ElicitationApprovalChannel(() => server.server);
  const deps: ExecutionDeps = {
    audit,
    approval:
      opts.approval ?? new ConfiguredApprovalChannel(dataDir, elicit, audit, opts.version),
    getConfig: () => loadConfig(dataDir),
    version: opts.version,
    principal: opts.principal,
  };

  for (const def of opts.tools) {
    const gated = def.mode === "write-gated" || def.mode === "destructive";
    server.registerTool(
      def.name,
      {
        description:
          `${def.description}\n` +
          `[governed: scope=${def.scope} mode=${def.mode} undo=${def.undo}` +
          (gated
            ? "; runs as dry-run preview unless live mode is on AND a human approves out-of-band]"
            : "]"),
        inputSchema: def.inputSchema,
      },
      async (args: Record<string, unknown>) => {
        const result = await executeGoverned(def, args, deps);
        return {
          content: [{ type: "text" as const, text: result.text }],
          isError: result.isError,
        };
      }
    );
  }

  return {
    server,
    audit,
    async connectStdio() {
      await server.connect(new StdioServerTransport());
    },
  };
}
