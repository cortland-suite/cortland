import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  AuditStore,
  createGovernedServer,
  type GovernedToolDef,
} from "@honeycrisp/governed";
import { TokenStore, type TokenRecord } from "./tokens.js";

/**
 * The remote gateway (docs/05 M1): the suite's governed servers, spoken to
 * over MCP streamable HTTP — with the contract intact.
 *
 * Exposure posture, enforced in code:
 *   - Binds 127.0.0.1 ONLY. There is no configuration to bind wider; public
 *     reachability is always a tunnel's explicit job (tailscale serve,
 *     cloudflared), never this process's.
 *   - Every request must carry a bearer token minted by `honeycrisp-remote
 *     token mint`. No token, unknown token, revoked token → 401. Verification
 *     is constant-time against stored hashes; the secret itself is nowhere on
 *     this machine.
 *   - A request carrying an Origin header is refused outright (403): no
 *     browser has any business here, and that closes DNS-rebinding attacks
 *     without a host allowlist to misconfigure.
 *   - read-scope tokens can invoke ONLY mode:"read" tools. Calls to anything
 *     else are refused BEFORE the gate and leave an audit row saying who was
 *     refused and why. Write-scope tokens meet the same gate as local calls:
 *     dry-run unless live, per-action human approval either way.
 *   - Every audit row from a remote session carries a principal:
 *     "token:<id> session:<sid8>" — the ledger answers who asked, from where.
 */

export interface Mount {
  name: string;
  version: string;
  tools: Array<Readonly<GovernedToolDef<Record<string, unknown>>>>;
}

export interface GatewayOptions {
  dataDir: string;
  port: number;
  mounts: Mount[];
  log?: (message: string) => void;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  tokenId: string;
  close: () => void;
}

const MAX_SESSIONS = 32;

export async function startGateway(opts: GatewayOptions) {
  const log = opts.log ?? (() => {});
  const tokens = new TokenStore(opts.dataDir);
  const scopeAudit = new AuditStore(opts.dataDir);
  const sessions = new Map<string, Session>();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`request error: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500).end(JSON.stringify({ error: "internal error" }));
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    // Browsers announce themselves with Origin; nothing here is for browsers.
    if (req.headers.origin !== undefined) {
      res.writeHead(403).end(JSON.stringify({ error: "browser origins are not served" }));
      return;
    }
    const token = bearerToken(req);
    const record = tokens.verify(token);
    if (!record) {
      log(`401 ${req.method} ${req.url} (bad or missing token)`);
      res
        .writeHead(401, { "WWW-Authenticate": 'Bearer realm="honeycrisp-remote"' })
        .end(JSON.stringify({ error: "missing or unknown bearer token" }));
      return;
    }

    const mount = opts.mounts.find(
      (m) => req.url === `/mcp/${m.name}` || req.url?.startsWith(`/mcp/${m.name}?`)
    );
    if (!mount) {
      res.writeHead(404).end(JSON.stringify({ error: "unknown mount" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      // A session is bound to the token that opened it. A different (even
      // valid) token cannot ride an existing session.
      if (session.tokenId !== record.id) {
        res.writeHead(403).end(JSON.stringify({ error: "session belongs to another token" }));
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    // New session (the initialize POST).
    if (req.method !== "POST") {
      res.writeHead(400).end(JSON.stringify({ error: "no such session" }));
      return;
    }
    if (sessions.size >= MAX_SESSIONS) {
      res.writeHead(429).end(JSON.stringify({ error: "too many sessions" }));
      return;
    }
    const sid = randomUUID();
    const principal = `token:${record.id} session:${sid.slice(0, 8)}`;
    const governed = buildSessionServer(mount, record, principal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sid,
    });
    const close = () => {
      sessions.delete(sid);
      governed.audit.close();
    };
    transport.onclose = close;
    sessions.set(sid, { transport, tokenId: record.id, close });
    await governed.server.connect(transport);
    log(`session ${sid.slice(0, 8)} opened on /mcp/${mount.name} by token:${record.id}`);
    await transport.handleRequest(req, res);
  }

  function buildSessionServer(mount: Mount, record: TokenRecord, principal: string) {
    const readTools = mount.tools.filter((t) => t.mode === "read");
    const withheld = mount.tools.filter((t) => t.mode !== "read");
    const governed = createGovernedServer({
      name: `honeycrisp-${mount.name}`,
      version: mount.version,
      appName: "honeycrisp",
      dataDir: opts.dataDir,
      tools: record.scope === "read" ? readTools : mount.tools,
      principal,
    });
    if (record.scope === "read") {
      // The withheld tools stay visible but refuse BEFORE the gate, so the
      // ledger records the attempt instead of a silent tool-not-found.
      for (const def of withheld) {
        governed.server.registerTool(
          def.name,
          {
            description:
              `${def.description}\n[UNAVAILABLE to this read-scope token: ` +
              `mode=${def.mode} requires a write-scope token]`,
            inputSchema: def.inputSchema,
          },
          async () => {
            scopeAudit.record({
              tool: def.name,
              scope: def.scope,
              mode: def.mode,
              undo: def.undo,
              args: {},
              dryRun: false,
              outcome: "denied",
              detail: `read-scope token cannot invoke ${def.mode} tools`,
              toolVersion: mount.version,
              principal,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `${def.name} refused: this token has read scope; ` +
                    `${def.mode} tools require a write-scope token. Nothing was executed.`,
                },
              ],
              isError: true,
            };
          }
        );
      }
    }
    return governed;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  const actualPort = (server.address() as { port: number }).port;
  log(
    `honeycrisp-remote listening on 127.0.0.1:${actualPort} — mounts: ` +
      opts.mounts.map((m) => `/mcp/${m.name}`).join(", ")
  );

  return {
    server,
    port: actualPort,
    async close() {
      for (const s of sessions.values()) {
        await s.transport.close().catch(() => {});
      }
      scopeAudit.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}
