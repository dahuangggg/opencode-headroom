import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createCollisionHash, createContentHash } from "./ccr.js";
import type { CCREntry, CCRPutInput, CCRStats, CCRStore } from "./types.js";

type Statement<T = unknown> = {
  get(...params: unknown[]): T | null | undefined;
  all(...params: unknown[]): T[];
  run(...params: unknown[]): unknown;
};

type DatabaseInstance = {
  exec(sql: string): void;
  query<T = unknown>(sql: string): Statement<T>;
};

type DatabaseConstructor = new (path: string) => DatabaseInstance;

interface BunSQLiteModule {
  Database: DatabaseConstructor;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ccr_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  call_id TEXT,
  tool TEXT,
  strategy TEXT NOT NULL,
  original_content BLOB NOT NULL,
  compressed_content BLOB NOT NULL,
  original_tokens INTEGER NOT NULL,
  compressed_tokens INTEGER NOT NULL,
  original_chars INTEGER NOT NULL,
  compressed_chars INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retrieval_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ccr_hash ON ccr_entries(hash);
CREATE INDEX IF NOT EXISTS idx_ccr_session ON ccr_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_ccr_expires_at ON ccr_entries(expires_at);
CREATE TABLE IF NOT EXISTS ccr_hash_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  original_content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ccr_hash_history_hash ON ccr_hash_history(hash);
`;

type Row = {
  id: number;
  hash: string;
  session_id: string;
  call_id: string | null;
  tool: string | null;
  strategy: string;
  original_content: Uint8Array;
  compressed_content: Uint8Array;
  original_tokens: number;
  compressed_tokens: number;
  original_chars: number;
  compressed_chars: number;
  created_at: number;
  expires_at: number;
  retrieval_count: number;
};

type HistoryRow = {
  original_content: Uint8Array;
};

function encodeContent(content: string): Buffer {
  return Buffer.from(content, "utf16le");
}

function decodeContent(content: Uint8Array): string {
  return Buffer.from(content).toString("utf16le");
}

function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("CCR ttlMs must be a positive finite number");
  }
}

function rowToEntry(row: Row): CCREntry {
  return {
    hash: row.hash,
    sessionID: row.session_id,
    callID: row.call_id ?? undefined,
    tool: row.tool ?? undefined,
    strategy: row.strategy,
    originalContent: decodeContent(row.original_content),
    compressedContent: decodeContent(row.compressed_content),
    originalTokens: row.original_tokens,
    compressedTokens: row.compressed_tokens,
    originalChars: row.original_chars,
    compressedChars: row.compressed_chars,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    retrievalCount: row.retrieval_count,
  };
}

export class BunSQLiteCCRStore implements CCRStore {
  private db: DatabaseInstance;

  constructor(
    path: string,
    Database: DatabaseConstructor,
    private now: () => number = () => Date.now(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
    this.backfillHashHistory();
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort privacy on platforms that support chmod.
    }
  }

  private historyRowsForHash(hash: string): HistoryRow[] {
    return this.db
      .query<HistoryRow>(
        "SELECT original_content FROM ccr_hash_history WHERE hash = ? ORDER BY id ASC",
      )
      .all(hash);
  }

  private backfillHashHistory(): void {
    this.db.exec(`
INSERT INTO ccr_hash_history (hash, original_content)
SELECT e.hash, e.original_content
FROM ccr_entries e
WHERE NOT EXISTS (
  SELECT 1
  FROM ccr_hash_history h
  WHERE h.hash = e.hash AND h.original_content = e.original_content
);
`);
  }

  private recordHashHistory(hash: string, originalContent: string): void {
    const encoded = encodeContent(originalContent);
    this.db
      .query(`INSERT INTO ccr_hash_history (hash, original_content)
        SELECT ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM ccr_hash_history
          WHERE hash = ? AND original_content = ?
        )`)
      .run(hash, encoded, hash, encoded);
  }

  private allocateHash(originalContent: string): string {
    const baseHash = createContentHash(originalContent);
    const baseRows = this.historyRowsForHash(baseHash);
    if (
      baseRows.length === 0 ||
      baseRows.every((row) => decodeContent(row.original_content) === originalContent)
    ) {
      return baseHash;
    }

    for (let attempt = 1; ; attempt += 1) {
      const candidate = createCollisionHash(originalContent, attempt);
      const candidateRows = this.historyRowsForHash(candidate);
      if (
        candidateRows.length === 0 ||
        candidateRows.every(
          (row) => decodeContent(row.original_content) === originalContent,
        )
      ) {
        return candidate;
      }
    }
  }

  async put(input: CCRPutInput): Promise<CCREntry> {
    validateTtl(input.ttlMs);

    const createdAt = this.now();
    const entry: CCREntry = {
      hash: this.allocateHash(input.originalContent),
      sessionID: input.sessionID,
      callID: input.callID,
      tool: input.tool,
      strategy: input.strategy,
      originalContent: input.originalContent,
      compressedContent: input.compressedContent,
      originalTokens: input.originalTokens,
      compressedTokens: input.compressedTokens,
      originalChars: input.originalContent.length,
      compressedChars: input.compressedContent.length,
      createdAt,
      expiresAt: createdAt + input.ttlMs,
      retrievalCount: 0,
    };

    this.db
      .query(`INSERT INTO ccr_entries
        (hash, session_id, call_id, tool, strategy, original_content, compressed_content,
         original_tokens, compressed_tokens, original_chars, compressed_chars,
         created_at, expires_at, retrieval_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.hash,
        entry.sessionID,
        entry.callID ?? null,
        entry.tool ?? null,
        entry.strategy,
        encodeContent(entry.originalContent),
        encodeContent(entry.compressedContent),
        entry.originalTokens,
        entry.compressedTokens,
        entry.originalChars,
        entry.compressedChars,
        entry.createdAt,
        entry.expiresAt,
        entry.retrievalCount,
      );
    this.recordHashHistory(entry.hash, entry.originalContent);

    return { ...entry };
  }

  async get(hash: string): Promise<CCREntry | null> {
    const now = this.now();
    this.db
      .query("DELETE FROM ccr_entries WHERE hash = ? AND expires_at <= ?")
      .run(hash, now);

    const row = this.db
      .query<Row>("SELECT * FROM ccr_entries WHERE hash = ? ORDER BY id DESC LIMIT 1")
      .get(hash);
    if (!row) {
      return null;
    }

    this.db
      .query("UPDATE ccr_entries SET retrieval_count = retrieval_count + 1 WHERE id = ?")
      .run(row.id);

    return { ...rowToEntry(row), retrievalCount: row.retrieval_count + 1 };
  }

  async stats(sessionID?: string): Promise<CCRStats> {
    await this.pruneExpired();

    const rows = sessionID
      ? this.db
          .query<Row>("SELECT * FROM ccr_entries WHERE session_id = ?")
          .all(sessionID)
      : this.db.query<Row>("SELECT * FROM ccr_entries").all();

    return {
      entryCount: rows.length,
      totalOriginalTokens: rows.reduce(
        (sum, row) => sum + row.original_tokens,
        0,
      ),
      totalCompressedTokens: rows.reduce(
        (sum, row) => sum + row.compressed_tokens,
        0,
      ),
      totalTokensSaved: rows.reduce(
        (sum, row) =>
          sum + Math.max(0, row.original_tokens - row.compressed_tokens),
        0,
      ),
      totalRetrievals: rows.reduce(
        (sum, row) => sum + row.retrieval_count,
        0,
      ),
    };
  }

  async pruneExpired(now: number = this.now()): Promise<number> {
    const expired =
      this.db
        .query<{ count: number }>(
          "SELECT COUNT(*) AS count FROM ccr_entries WHERE expires_at <= ?",
        )
        .get(now)?.count ?? 0;

    this.db.query("DELETE FROM ccr_entries WHERE expires_at <= ?").run(now);

    return expired;
  }
}

export async function createBunSQLiteStore(path: string): Promise<CCRStore> {
  const specifier = "bun:sqlite";
  const mod = (await import(specifier)) as BunSQLiteModule;
  return new BunSQLiteCCRStore(path, mod.Database);
}
