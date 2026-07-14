import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  createContentDigest,
  DEFAULT_CCR_HASH_PROVIDER,
  type CCRHashProvider,
} from "./ccr.js";
import {
  resolveCCRMaxEntries,
  resolveSQLiteBusyTimeoutMs,
  type CCREntry,
  type CCRPutInput,
  type CCRStats,
  type CCRStore,
  type CCRStoreDiagnostics,
  type CCRStoreOptions,
} from "./types.js";

type Statement<T = unknown> = {
  get(...params: unknown[]): T | null | undefined;
  all(...params: unknown[]): T[];
  run(...params: unknown[]): unknown;
};

type DatabaseInstance = {
  close(): void;
  exec(sql: string): void;
  query<T = unknown>(sql: string): Statement<T>;
};

type DatabaseConstructor = new (path: string) => DatabaseInstance;

interface BunSQLiteModule {
  Database: DatabaseConstructor;
}

const SQLITE_SCHEMA_VERSION = 2;

const ENTRY_SCHEMA = `
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
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  retrieve_default_mode TEXT NOT NULL DEFAULT 'summary',
  retrieve_default_max_chars INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ccr_hash ON ccr_entries(hash);
CREATE INDEX IF NOT EXISTS idx_ccr_session ON ccr_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_ccr_expires_at ON ccr_entries(expires_at);
`;

const HASH_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS ccr_hash_history (
  hash TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (hash, content_digest)
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
  retrieve_default_mode: string;
  retrieve_default_max_chars: number | null;
};

type HistoryRow = {
  content_digest: string;
};

type LegacyHistoryRow = {
  hash: string;
  original_content: Uint8Array;
};

type TableInfoRow = {
  name: string;
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
    retrieveDefaults: {
      mode: ["summary", "head", "tail", "full"].includes(
        row.retrieve_default_mode,
      )
        ? (row.retrieve_default_mode as "summary" | "head" | "tail" | "full")
        : "summary",
      ...(row.retrieve_default_max_chars === null
        ? {}
        : { maxChars: row.retrieve_default_max_chars }),
    },
  };
}

export class BunSQLiteCCRStore implements CCRStore {
  readonly diagnostics: CCRStoreDiagnostics;
  private db: DatabaseInstance;
  private closed = false;
  private maxEntries: number;

  constructor(
    path: string,
    Database: DatabaseConstructor,
    private now: () => number = () => Date.now(),
    options: CCRStoreOptions = {},
    diagnostics: CCRStoreDiagnostics = {
      requested: "bun-sqlite",
      active: "bun-sqlite",
    },
    private hashing: CCRHashProvider = DEFAULT_CCR_HASH_PROVIDER,
  ) {
    this.diagnostics = { ...diagnostics };
    this.maxEntries = resolveCCRMaxEntries(options.maxEntries);
    const busyTimeoutMs = resolveSQLiteBusyTimeoutMs(options.busyTimeoutMs);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    this.db.exec("PRAGMA secure_delete = ON");
    const existingSchemaVersion =
      this.db
        .query<{ user_version: number }>("PRAGMA user_version")
        .get()?.user_version ?? 0;
    if (existingSchemaVersion > SQLITE_SCHEMA_VERSION) {
      this.db.close();
      this.closed = true;
      throw new Error(
        `CCR database uses newer schema version ${existingSchemaVersion}; this build supports ${SQLITE_SCHEMA_VERSION}`,
      );
    }
    this.db.exec(ENTRY_SCHEMA);
    this.migrateEntryRetrieveDefaults();
    this.migrateHashHistory();
    this.deleteExpiredEntries(this.now());
    this.enforceCapacityLimit();
    this.rebuildHashHistory();
    this.db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort privacy on platforms that support chmod.
    }
  }

  private historyRowsForHash(hash: string): HistoryRow[] {
    return this.db
      .query<HistoryRow>(
        "SELECT content_digest FROM ccr_hash_history WHERE hash = ?",
      )
      .all(hash);
  }

  private migrateEntryRetrieveDefaults(): void {
    const columns = this.db
      .query<TableInfoRow>("PRAGMA table_info(ccr_entries)")
      .all();
    if (!columns.some((column) => column.name === "retrieve_default_mode")) {
      this.db.exec(
        "ALTER TABLE ccr_entries ADD COLUMN retrieve_default_mode TEXT NOT NULL DEFAULT 'summary'",
      );
    }
    if (
      !columns.some((column) => column.name === "retrieve_default_max_chars")
    ) {
      this.db.exec(
        "ALTER TABLE ccr_entries ADD COLUMN retrieve_default_max_chars INTEGER",
      );
      this.db
        .query(
          "UPDATE ccr_entries SET retrieve_default_max_chars = 12000 WHERE retrieve_default_mode != 'full'",
        )
        .run();
    }
  }

  private migrateHashHistory(): void {
    const columns = this.db
      .query<TableInfoRow>("PRAGMA table_info(ccr_hash_history)")
      .all();
    if (columns.length === 0) {
      this.db.exec(HASH_HISTORY_SCHEMA);
      return;
    }
    if (columns.some((column) => column.name === "content_digest")) {
      this.db.exec(HASH_HISTORY_SCHEMA);
      return;
    }

    const legacyRows = this.db
      .query<LegacyHistoryRow>(
        "SELECT hash, original_content FROM ccr_hash_history",
      )
      .all();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DROP TABLE ccr_hash_history");
      this.db.exec(HASH_HISTORY_SCHEMA);
      const insert = this.db.query(
        "INSERT OR IGNORE INTO ccr_hash_history (hash, content_digest) VALUES (?, ?)",
      );
      for (const row of legacyRows) {
        insert.run(
          row.hash,
          createContentDigest(decodeContent(row.original_content)),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("VACUUM");
  }

  private backfillHashHistory(): void {
    const rows = this.db
      .query<{ hash: string; original_content: Uint8Array }>(
        "SELECT hash, original_content FROM ccr_entries",
      )
      .all();
    for (const row of rows) {
      this.recordHashHistory(row.hash, decodeContent(row.original_content));
    }
  }

  private rebuildHashHistory(): void {
    this.db.query("DELETE FROM ccr_hash_history").run();
    this.backfillHashHistory();
  }

  private deleteOrphanedHashHistory(): void {
    this.db
      .query(`DELETE FROM ccr_hash_history
        WHERE NOT EXISTS (
          SELECT 1 FROM ccr_entries
          WHERE ccr_entries.hash = ccr_hash_history.hash
        )`)
      .run();
  }

  private recordHashHistory(hash: string, originalContent: string): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO ccr_hash_history (hash, content_digest) VALUES (?, ?)",
      )
      .run(hash, this.hashing.contentDigest(originalContent));
  }

  private allocateHash(originalContent: string): string {
    const contentDigest = this.hashing.contentDigest(originalContent);
    const baseHash = this.hashing.contentHash(originalContent);
    const baseRows = this.historyRowsForHash(baseHash);
    if (
      baseRows.length === 0 ||
      baseRows.every((row) => row.content_digest === contentDigest)
    ) {
      return baseHash;
    }

    for (let attempt = 1; ; attempt += 1) {
      const candidate = this.hashing.collisionHash(originalContent, attempt);
      const candidateRows = this.historyRowsForHash(candidate);
      if (
        candidateRows.length === 0 ||
        candidateRows.every((row) => row.content_digest === contentDigest)
      ) {
        return candidate;
      }
    }
  }

  private deleteExpiredEntries(now: number): number {
    const expired =
      this.db
        .query<{ count: number }>(
          "SELECT COUNT(*) AS count FROM ccr_entries WHERE expires_at <= ?",
        )
        .get(now)?.count ?? 0;
    this.db.query("DELETE FROM ccr_entries WHERE expires_at <= ?").run(now);
    return expired;
  }

  private enforceCapacityLimit(incomingEntries = 0): number {
    const entryCount =
      this.db
        .query<{ count: number }>("SELECT COUNT(*) AS count FROM ccr_entries")
        .get()?.count ?? 0;
    const entriesToEvict = Math.max(
      0,
      entryCount - this.maxEntries + incomingEntries,
    );
    if (entriesToEvict === 0) {
      return 0;
    }
    this.db
      .query(`DELETE FROM ccr_entries
        WHERE id IN (
          SELECT id FROM ccr_entries
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        )`)
      .run(entriesToEvict);
    return entriesToEvict;
  }

  async put(input: CCRPutInput): Promise<CCREntry> {
    validateTtl(input.ttlMs);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const createdAt = this.now();
      const removedExpired = this.deleteExpiredEntries(createdAt);
      const removedForCapacity = this.enforceCapacityLimit(1);
      if (removedExpired > 0 || removedForCapacity > 0) {
        this.deleteOrphanedHashHistory();
      }
      const hash = this.allocateHash(input.originalContent);
      const compressed = input.contentForHash?.(hash) ?? {
        compressedContent: input.compressedContent,
        compressedTokens: input.compressedTokens,
      };
      const entry: CCREntry = {
        hash,
        sessionID: input.sessionID,
        callID: input.callID,
        tool: input.tool,
        strategy: input.strategy,
        originalContent: input.originalContent,
        compressedContent: compressed.compressedContent,
        originalTokens: input.originalTokens,
        compressedTokens: compressed.compressedTokens,
        originalChars: input.originalContent.length,
        compressedChars: compressed.compressedContent.length,
        createdAt,
        expiresAt: createdAt + input.ttlMs,
        retrievalCount: 0,
        retrieveDefaults: input.retrieveDefaults
          ? { ...input.retrieveDefaults }
          : { mode: "summary", maxChars: 12_000 },
      };

      this.db
        .query(`INSERT INTO ccr_entries
        (hash, session_id, call_id, tool, strategy, original_content, compressed_content,
         original_tokens, compressed_tokens, original_chars, compressed_chars,
         created_at, expires_at, retrieval_count, retrieve_default_mode,
         retrieve_default_max_chars)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
          entry.retrieveDefaults?.mode ?? "summary",
          entry.retrieveDefaults?.maxChars ?? null,
        );
      this.recordHashHistory(entry.hash, entry.originalContent);
      this.db.exec("COMMIT");

      return { ...entry };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original allocation or write error.
      }
      throw error;
    }
  }

  private findEntry(
    hash: string,
    sessionID: string | undefined,
    countRetrieval: boolean,
  ): CCREntry | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.deleteExpiredEntries(this.now()) > 0) {
        this.deleteOrphanedHashHistory();
      }

      const row = sessionID
        ? this.db
            .query<Row>(
              "SELECT * FROM ccr_entries WHERE hash = ? AND session_id = ? ORDER BY id DESC LIMIT 1",
            )
            .get(hash, sessionID)
        : this.db
            .query<Row>(
              "SELECT * FROM ccr_entries WHERE hash = ? ORDER BY id DESC LIMIT 1",
            )
            .get(hash);
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      if (countRetrieval) {
        this.db
          .query("UPDATE ccr_entries SET retrieval_count = retrieval_count + 1 WHERE id = ?")
          .run(row.id);
      }
      this.db.exec("COMMIT");
      return {
        ...rowToEntry(row),
        retrievalCount: row.retrieval_count + (countRetrieval ? 1 : 0),
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original retrieval error.
      }
      throw error;
    }
  }

  async peek(hash: string, sessionID?: string): Promise<CCREntry | null> {
    return this.findEntry(hash, sessionID, false);
  }

  async get(hash: string, sessionID?: string): Promise<CCREntry | null> {
    return this.findEntry(hash, sessionID, true);
  }

  async deleteSession(sessionID: string): Promise<number> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteExpiredEntries(this.now());
      const removed =
        this.db
          .query<{ count: number }>(
            "SELECT COUNT(*) AS count FROM ccr_entries WHERE session_id = ?",
          )
          .get(sessionID)?.count ?? 0;
      this.db
        .query("DELETE FROM ccr_entries WHERE session_id = ?")
        .run(sessionID);
      this.deleteOrphanedHashHistory();
      this.db.exec("COMMIT");
      return removed;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original delete error.
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.db.close();
    this.closed = true;
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.deleteExpiredEntries(now);
      if (removed > 0) {
        this.deleteOrphanedHashHistory();
      }
      this.db.exec("COMMIT");
      return removed;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original pruning error.
      }
      throw error;
    }
  }
}

export async function createBunSQLiteStore(
  path: string,
  options: CCRStoreOptions = {},
  diagnostics?: CCRStoreDiagnostics,
): Promise<CCRStore> {
  const specifier = "bun:sqlite";
  const mod = (await import(specifier)) as BunSQLiteModule;
  return new BunSQLiteCCRStore(
    path,
    mod.Database,
    undefined,
    options,
    diagnostics,
  );
}
