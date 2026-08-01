import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { ToolMode, UndoKind } from "./types.js";

export type AuditOutcome =
  | "ok"
  | "error"
  | "dry-run"
  | "denied"
  | "refused-no-undo";

export interface AuditEntry {
  tool: string;
  scope: string;
  mode: ToolMode;
  undo: UndoKind;
  /** Already redacted — never pass raw args here. */
  args: Record<string, unknown>;
  dryRun: boolean;
  outcome: AuditOutcome;
  approvalId?: string;
  approvalMethod?: string;
  detail?: string;
  undoRecipe?: unknown;
  toolVersion: string;
}

export interface AuditRow extends AuditEntry {
  id: string;
  ts: string;
}

/**
 * One shared SQLite DB for the whole suite: one place to inspect everything the
 * suite ever did. Every execution path writes a row — success, error, dry-run,
 * denial, refusal. Rows are inserted synchronously so a crash after the action
 * cannot lose the record of it.
 */
export class AuditStore {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "audit.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        tool TEXT NOT NULL,
        scope TEXT NOT NULL,
        mode TEXT NOT NULL,
        undo TEXT NOT NULL,
        args_json TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        approval_id TEXT,
        approval_method TEXT,
        detail TEXT,
        undo_recipe_json TEXT,
        tool_version TEXT NOT NULL
      )
    `);
  }

  record(entry: AuditEntry): AuditRow {
    const row: AuditRow = {
      ...entry,
      id: randomUUID(),
      ts: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO audit
         (id, ts, tool, scope, mode, undo, args_json, dry_run, outcome,
          approval_id, approval_method, detail, undo_recipe_json, tool_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.ts,
        row.tool,
        row.scope,
        row.mode,
        row.undo,
        JSON.stringify(row.args),
        row.dryRun ? 1 : 0,
        row.outcome,
        row.approvalId ?? null,
        row.approvalMethod ?? null,
        row.detail ?? null,
        row.undoRecipe === undefined ? null : JSON.stringify(row.undoRecipe),
        row.toolVersion
      );
    return row;
  }

  list(limit = 100): AuditRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit ORDER BY ts DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      ts: r.ts as string,
      tool: r.tool as string,
      scope: r.scope as string,
      mode: r.mode as ToolMode,
      undo: r.undo as UndoKind,
      args: JSON.parse(r.args_json as string) as Record<string, unknown>,
      dryRun: (r.dry_run as number) === 1,
      outcome: r.outcome as AuditOutcome,
      approvalId: (r.approval_id as string | null) ?? undefined,
      approvalMethod: (r.approval_method as string | null) ?? undefined,
      detail: (r.detail as string | null) ?? undefined,
      undoRecipe:
        r.undo_recipe_json == null
          ? undefined
          : (JSON.parse(r.undo_recipe_json as string) as unknown),
      toolVersion: r.tool_version as string,
    }));
  }

  close(): void {
    this.db.close();
  }
}
