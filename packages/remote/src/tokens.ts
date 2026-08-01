import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bearer tokens for the remote gateway (docs/05 M1).
 *
 * The server NEVER stores a token — only its SHA-256 hash, plus metadata
 * (id, scope, label, created). The secret is shown exactly once at mint time
 * and lives wherever the human puts it (their client's config). Losing it
 * means minting a new one; there is nothing to steal from this Mac. Hashes
 * and metadata live in tokens.json (0600) in the suite data dir — hashes are
 * not secrets, so the house rule (secrets in Keychain or nowhere) holds.
 *
 * Scopes: "read" may call only mode:"read" tools. "write" may call
 * everything — and still meets the gate: live mode + per-action human
 * approval apply to remote calls exactly as local ones. The scope check
 * happens BEFORE the gate and is audited (see gateway.ts).
 */

export type TokenScope = "read" | "write";

export interface TokenRecord {
  id: string; // short public id, safe for audit rows
  sha256: string;
  scope: TokenScope;
  label: string;
  createdAt: string;
}

export interface MintResult {
  /** The full secret. Shown once; never stored. */
  token: string;
  record: TokenRecord;
}

export class TokenStore {
  private file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "remote-tokens.json");
  }

  mint(scope: TokenScope, label: string): MintResult {
    const id = randomBytes(4).toString("hex");
    const secret = `hc_${randomBytes(24).toString("hex")}`;
    const record: TokenRecord = {
      id,
      sha256: sha256(secret),
      scope,
      label,
      createdAt: new Date().toISOString(),
    };
    const all = this.list();
    all.push(record);
    this.save(all);
    return { token: secret, record };
  }

  list(): TokenRecord[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(parsed) ? (parsed as TokenRecord[]) : [];
    } catch {
      return [];
    }
  }

  revoke(id: string): boolean {
    const all = this.list();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) return false;
    this.save(next);
    return true;
  }

  /** Constant-time verification. Returns the matching record or null. */
  verify(presented: string | undefined): TokenRecord | null {
    if (!presented || !presented.startsWith("hc_")) return null;
    const hash = Buffer.from(sha256(presented), "hex");
    for (const record of this.list()) {
      const stored = Buffer.from(record.sha256, "hex");
      if (stored.length === hash.length && timingSafeEqual(stored, hash)) {
        return record;
      }
    }
    return null;
  }

  private save(records: TokenRecord[]): void {
    fs.writeFileSync(this.file, JSON.stringify(records, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.chmodSync(this.file, 0o600);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
