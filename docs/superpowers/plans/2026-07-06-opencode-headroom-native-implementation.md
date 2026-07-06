# OpenCode Headroom Native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a root-level `opencode-headroom` npm package that provides a Headroom-compatible native OpenCode plugin for after-hook tool-output compression, CCR retrieval, and stats.

**Architecture:** The plugin layer only talks to a `CompressionEngine`; P0 ships a `NativeHeadroomCompatibleEngine` implemented in TypeScript. The native engine routes tool output through Headroom-aligned detectors and compressors, writes original output to a local CCR store before emitting markers, and exposes retrieval/stats via native OpenCode tools.

**Tech Stack:** TypeScript ESM, Node 22+, Vitest, `@opencode-ai/plugin`, Zod v4 host schemas, optional `bun:sqlite` loaded dynamically, memory store fallback.

---

## File Structure

Create these files:

- `package.json`: npm metadata, scripts, dependencies, exports.
- `tsconfig.json`: strict ESM TypeScript config.
- `vitest.config.ts`: Vitest config.
- `src/token.ts`: deterministic token estimator.
- `src/markers.ts`: CCR marker formatting and detection.
- `src/config.ts`: config normalization, skip patterns, defaults.
- `src/engine/types.ts`: public engine input/output contracts.
- `src/store/types.ts`: CCR entry/store/stat contracts.
- `src/store/memory.ts`: in-memory CCR store for tests and fallback.
- `src/store/sqlite-bun.ts`: optional Bun SQLite CCR store.
- `src/store/ccr.ts`: store factory and hash helpers.
- `src/engine/router.ts`: content detection and compressor routing.
- `src/compressors/types.ts`: shared compressor contract.
- `src/compressors/json.ts`: SmartCrusher-lite JSON compressor.
- `src/compressors/search.ts`: Headroom-style search compressor.
- `src/compressors/log.ts`: Headroom-style log compressor.
- `src/compressors/text.ts`: extractive text compressor.
- `src/engine/native.ts`: native engine orchestration.
- `src/tools/retrieve.ts`: native `headroom_retrieve` tool.
- `src/tools/stats.ts`: native `headroom_stats` tool.
- `src/plugin.ts`: OpenCode plugin entry.
- `src/index.ts`: package exports.
- `opencode.json.example`: example config.
- `DESIGN.md`: short pointer to the approved spec.

Create these test files:

- `tests/token-markers.test.ts`
- `tests/config.test.ts`
- `tests/store.test.ts`
- `tests/router.test.ts`
- `tests/json-compressor.test.ts`
- `tests/search-compressor.test.ts`
- `tests/log-compressor.test.ts`
- `tests/text-compressor.test.ts`
- `tests/native-engine.test.ts`
- `tests/plugin.test.ts`
- `tests/fixtures.ts`

No task modifies `headroom/`; it remains reference source only.

---

### Task 1: Package Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Write package and build config**

Create `package.json`:

```json
{
  "name": "opencode-headroom",
  "version": "0.1.0",
  "description": "Headroom-compatible native OpenCode plugin for tool-output compression and CCR retrieval",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./plugin": {
      "types": "./dist/plugin.d.ts",
      "default": "./dist/plugin.js"
    }
  },
  "files": [
    "dist",
    "README.md",
    "DESIGN.md",
    "opencode.json.example"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@opencode-ai/plugin": "^1.17.8",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.5.0",
    "vitest": "^4.1.5"
  },
  "license": "Apache-2.0"
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

Create `src/index.ts`:

```ts
export { default, HeadroomNativePlugin } from "./plugin.js";
export type { HeadroomPluginOptions } from "./config.js";
export type {
  CompressionEngine,
  ToolOutputCompressionInput,
  ToolOutputCompressionResult,
} from "./engine/types.js";
```

- [ ] **Step 2: Install dependencies**

Run: `bun install`

Expected: `bun.lock` is created and dependencies install without network/package errors.

- [ ] **Step 3: Run typecheck and observe missing plugin**

Run: `bun run typecheck`

Expected: FAIL with `Cannot find module './plugin.js'` from `src/index.ts`.

- [ ] **Step 4: Commit scaffold**

```bash
git add package.json tsconfig.json vitest.config.ts src/index.ts bun.lock
git commit -m "chore: scaffold opencode headroom package"
```

---

### Task 2: Token, Marker, and Config Primitives

**Files:**
- Create: `src/token.ts`
- Create: `src/markers.ts`
- Create: `src/config.ts`
- Test: `tests/token-markers.test.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing token and marker tests**

Create `tests/token-markers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/token.js";
import {
  CCR_HASH_RE,
  containsCCRMarker,
  formatJsonSentinel,
  formatRetrieveMarker,
  isValidCCRHash,
} from "../src/markers.js";

describe("token estimation and CCR markers", () => {
  it("estimates tokens by chars divided by four", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("validates 24-character hex hashes", () => {
    expect(isValidCCRHash("0123456789abcdef01234567")).toBe(true);
    expect(isValidCCRHash("012345")).toBe(false);
    expect(isValidCCRHash("zzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false);
    expect("hash=0123456789abcdef01234567").toMatch(CCR_HASH_RE);
  });

  it("formats Headroom-style markers", () => {
    const hash = "0123456789abcdef01234567";
    expect(formatJsonSentinel(hash, 12)).toEqual({
      _ccr_dropped: "<<ccr:0123456789abcdef01234567 12_rows_offloaded>>",
    });
    expect(formatRetrieveMarker(hash)).toBe(
      "[Retrieve more: hash=0123456789abcdef01234567]",
    );
    expect(containsCCRMarker(`x ${formatRetrieveMarker(hash)}`)).toBe(true);
    expect(containsCCRMarker("plain")).toBe(false);
  });
});
```

- [ ] **Step 2: Write failing config tests**

Create `tests/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeConfig, shouldSkipTool } from "../src/config.js";

describe("config", () => {
  it("normalizes defaults", () => {
    const config = normalizeConfig();
    expect(config.engine).toBe("native");
    expect(config.thresholdTokens).toBe(2000);
    expect(config.thresholdChars).toBe(8000);
    expect(config.ttlHours).toBe(24);
    expect(config.skipTools).toEqual(["headroom_*", "ctx_*"]);
  });

  it("rejects unsupported engines", () => {
    expect(() => normalizeConfig({ engine: "headroom-http" as never })).toThrow(
      /Unsupported engine/,
    );
  });

  it("matches skip patterns", () => {
    const config = normalizeConfig({ skipTools: ["ctx_*", "Read"] });
    expect(shouldSkipTool("ctx_search", config)).toBe(true);
    expect(shouldSkipTool("Read", config)).toBe(true);
    expect(shouldSkipTool("Bash", config)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test tests/token-markers.test.ts tests/config.test.ts`

Expected: FAIL with module-not-found errors for `src/token.ts`, `src/markers.ts`, and `src/config.ts`.

- [ ] **Step 4: Implement primitives**

Create `src/token.ts`:

```ts
export function estimateTokens(content: string): number {
  if (!content) return 0;
  return Math.ceil(content.length / 4);
}
```

Create `src/markers.ts`:

```ts
export const CCR_HASH_RE = /\b[a-f0-9]{24}\b/i;
const FULL_HASH_RE = /^[a-f0-9]{24}$/i;
const MARKER_RE = /<<ccr:[a-f0-9]{24}\b[^>]*>>|\[Retrieve more: hash=[a-f0-9]{24}\]/i;

export function isValidCCRHash(hash: string): boolean {
  return FULL_HASH_RE.test(hash);
}

export function containsCCRMarker(content: string): boolean {
  return MARKER_RE.test(content);
}

export function formatJsonSentinel(hash: string, rowsOffloaded: number): { _ccr_dropped: string } {
  return { _ccr_dropped: `<<ccr:${hash} ${rowsOffloaded}_rows_offloaded>>` };
}

export function formatRetrieveMarker(hash: string): string {
  return `[Retrieve more: hash=${hash}]`;
}
```

Create `src/config.ts`:

```ts
export type EngineName = "native";

export interface HeadroomPluginOptions {
  engine?: EngineName;
  thresholdTokens?: number;
  thresholdChars?: number;
  ttlHours?: number;
  storage?: {
    kind?: "auto" | "memory" | "bun-sqlite";
    path?: string;
  };
  skipTools?: string[];
  maxOutputChars?: number;
  debug?: boolean;
}

export interface NormalizedConfig {
  engine: EngineName;
  thresholdTokens: number;
  thresholdChars: number;
  ttlHours: number;
  storage: {
    kind: "auto" | "memory" | "bun-sqlite";
    path: string;
  };
  skipTools: string[];
  maxOutputChars: number;
  debug: boolean;
}

export function normalizeConfig(options: HeadroomPluginOptions = {}): NormalizedConfig {
  const engine = options.engine ?? "native";
  if (engine !== "native") {
    throw new Error(`Unsupported engine for P0: ${String(engine)}`);
  }
  return {
    engine,
    thresholdTokens: options.thresholdTokens ?? 2000,
    thresholdChars: options.thresholdChars ?? 8000,
    ttlHours: options.ttlHours ?? 24,
    storage: {
      kind: options.storage?.kind ?? "auto",
      path: options.storage?.path ?? ".headroom/ccr.sqlite",
    },
    skipTools: options.skipTools ?? ["headroom_*", "ctx_*"],
    maxOutputChars: options.maxOutputChars ?? 250_000,
    debug: options.debug ?? false,
  };
}

export function shouldSkipTool(toolName: string, config: NormalizedConfig): boolean {
  return config.skipTools.some((pattern) => {
    if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
    return toolName === pattern;
  });
}
```

- [ ] **Step 5: Run tests**

Run: `bun run test tests/token-markers.test.ts tests/config.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/token.ts src/markers.ts src/config.ts tests/token-markers.test.ts tests/config.test.ts
git commit -m "feat: add token marker and config primitives"
```

---

### Task 3: CCR Store Contracts and Memory Store

**Files:**
- Create: `src/store/types.ts`
- Create: `src/store/memory.ts`
- Create: `src/store/ccr.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write failing memory store tests**

Create `tests/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createContentHash, createCCRStore } from "../src/store/ccr.js";
import { MemoryCCRStore } from "../src/store/memory.js";

describe("CCR store", () => {
  it("hashes original content with sha256 truncated to 24 hex chars", () => {
    expect(createContentHash("hello world")).toMatch(/^[a-f0-9]{24}$/);
    expect(createContentHash("hello world")).toBe(createContentHash("hello world"));
    expect(createContentHash("hello world")).not.toBe(createContentHash("hello world!"));
  });

  it("stores and retrieves exact original content", async () => {
    const store = new MemoryCCRStore();
    const entry = await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Bash",
      strategy: "search",
      originalContent: "original output",
      compressedContent: "compressed output",
      originalTokens: 4,
      compressedTokens: 2,
      ttlMs: 60_000,
    });

    const got = await store.get(entry.hash);
    expect(got?.originalContent).toBe("original output");
    expect(got?.retrievalCount).toBe(1);
  });

  it("expires entries", async () => {
    const store = new MemoryCCRStore(() => 1000);
    const entry = await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Read",
      strategy: "json",
      originalContent: "x",
      compressedContent: "y",
      originalTokens: 1,
      compressedTokens: 1,
      ttlMs: 1,
    });

    store.setNowForTest(() => 1002);
    expect(await store.get(entry.hash)).toBeNull();
    expect((await store.stats()).entryCount).toBe(0);
  });

  it("aggregates stats", async () => {
    const store = new MemoryCCRStore();
    await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Bash",
      strategy: "log",
      originalContent: "a".repeat(40),
      compressedContent: "b".repeat(8),
      originalTokens: 10,
      compressedTokens: 2,
      ttlMs: 60_000,
    });
    const stats = await store.stats("s1");
    expect(stats.entryCount).toBe(1);
    expect(stats.totalOriginalTokens).toBe(10);
    expect(stats.totalCompressedTokens).toBe(2);
    expect(stats.totalTokensSaved).toBe(8);
  });

  it("factory creates memory store", async () => {
    const store = await createCCRStore({ kind: "memory", path: ".x" });
    expect(store).toBeInstanceOf(MemoryCCRStore);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun run test tests/store.test.ts`

Expected: FAIL with missing store modules.

- [ ] **Step 3: Implement store types**

Create `src/store/types.ts`:

```ts
export interface CCRPutInput {
  sessionID: string;
  callID?: string;
  tool?: string;
  strategy: string;
  originalContent: string;
  compressedContent: string;
  originalTokens: number;
  compressedTokens: number;
  ttlMs: number;
}

export interface CCREntry {
  hash: string;
  sessionID: string;
  callID?: string;
  tool?: string;
  strategy: string;
  originalContent: string;
  compressedContent: string;
  originalTokens: number;
  compressedTokens: number;
  originalChars: number;
  compressedChars: number;
  createdAt: number;
  expiresAt: number;
  retrievalCount: number;
}

export interface CCRStats {
  entryCount: number;
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  totalTokensSaved: number;
  totalRetrievals: number;
}

export interface CCRStore {
  put(input: CCRPutInput): Promise<CCREntry>;
  get(hash: string): Promise<CCREntry | null>;
  stats(sessionID?: string): Promise<CCRStats>;
  pruneExpired(now?: number): Promise<number>;
}
```

- [ ] **Step 4: Implement memory store and factory**

Create `src/store/memory.ts`:

```ts
import { createContentHash } from "./ccr.js";
import type { CCREntry, CCRPutInput, CCRStats, CCRStore } from "./types.js";

export class MemoryCCRStore implements CCRStore {
  private entries = new Map<string, CCREntry>();

  constructor(private now: () => number = () => Date.now()) {}

  setNowForTest(now: () => number): void {
    this.now = now;
  }

  async put(input: CCRPutInput): Promise<CCREntry> {
    const createdAt = this.now();
    const hash = createContentHash(input.originalContent);
    const entry: CCREntry = {
      hash,
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
    this.entries.set(hash, entry);
    return { ...entry };
  }

  async get(hash: string): Promise<CCREntry | null> {
    const entry = this.entries.get(hash);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(hash);
      return null;
    }
    entry.retrievalCount += 1;
    return { ...entry };
  }

  async stats(sessionID?: string): Promise<CCRStats> {
    await this.pruneExpired();
    const entries = [...this.entries.values()].filter((entry) => !sessionID || entry.sessionID === sessionID);
    return {
      entryCount: entries.length,
      totalOriginalTokens: entries.reduce((sum, entry) => sum + entry.originalTokens, 0),
      totalCompressedTokens: entries.reduce((sum, entry) => sum + entry.compressedTokens, 0),
      totalTokensSaved: entries.reduce((sum, entry) => sum + Math.max(0, entry.originalTokens - entry.compressedTokens), 0),
      totalRetrievals: entries.reduce((sum, entry) => sum + entry.retrievalCount, 0),
    };
  }

  async pruneExpired(now: number = this.now()): Promise<number> {
    let removed = 0;
    for (const [hash, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }
}
```

Create `src/store/ccr.ts`:

```ts
import { createHash } from "node:crypto";
import type { CCRStore } from "./types.js";
import { MemoryCCRStore } from "./memory.js";

export interface StoreFactoryOptions {
  kind: "auto" | "memory" | "bun-sqlite";
  path: string;
}

export function createContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

export async function createCCRStore(options: StoreFactoryOptions): Promise<CCRStore> {
  if (options.kind === "memory") return new MemoryCCRStore();
  if (options.kind === "bun-sqlite") {
    const mod = await import("./sqlite-bun.js");
    return mod.createBunSQLiteStore(options.path);
  }
  try {
    const mod = await import("./sqlite-bun.js");
    return mod.createBunSQLiteStore(options.path);
  } catch {
    return new MemoryCCRStore();
  }
}
```

- [ ] **Step 5: Add temporary sqlite module stub**

Create `src/store/sqlite-bun.ts`:

```ts
import { MemoryCCRStore } from "./memory.js";
import type { CCRStore } from "./types.js";

export async function createBunSQLiteStore(_path: string): Promise<CCRStore> {
  return new MemoryCCRStore();
}
```

This stub keeps the factory compiling. Task 4 replaces it with a real Bun SQLite adapter.

- [ ] **Step 6: Run tests**

Run: `bun run test tests/store.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store tests/store.test.ts
git commit -m "feat: add ccr store contracts and memory store"
```

---

### Task 4: Bun SQLite Store Adapter

**Files:**
- Modify: `src/store/sqlite-bun.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Add SQLite adapter tests**

Append to `tests/store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBunSQLiteStore } from "../src/store/sqlite-bun.js";

describe("Bun SQLite CCR store", () => {
  it("round-trips when bun:sqlite is available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-"));
    try {
      const store = await createBunSQLiteStore(join(dir, "ccr.sqlite"));
      const entry = await store.put({
        sessionID: "s1",
        callID: "c1",
        tool: "Bash",
        strategy: "search",
        originalContent: "original sqlite",
        compressedContent: "compressed sqlite",
        originalTokens: 4,
        compressedTokens: 2,
        ttlMs: 60_000,
      });
      expect((await store.get(entry.hash))?.originalContent).toBe("original sqlite");
      expect((await store.stats("s1")).entryCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run SQLite test against stub**

Run: `bun run test tests/store.test.ts -t "Bun SQLite CCR store"`

Expected: PASS against the stub, which is acceptable before replacing implementation because the behavioral contract is the same.

- [ ] **Step 3: Replace stub with dynamic Bun SQLite implementation**

Replace `src/store/sqlite-bun.ts`:

```ts
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CCREntry, CCRPutInput, CCRStats, CCRStore } from "./types.js";
import { createContentHash } from "./ccr.js";

type DatabaseConstructor = new (path: string) => {
  exec(sql: string): void;
  query<T = unknown>(sql: string): {
    get(...params: unknown[]): T | null;
    all(...params: unknown[]): T[];
    run(...params: unknown[]): unknown;
  };
};

interface BunSQLiteModule {
  Database: DatabaseConstructor;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ccr_entries (
  hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  call_id TEXT,
  tool TEXT,
  strategy TEXT NOT NULL,
  original_content TEXT NOT NULL,
  compressed_content TEXT NOT NULL,
  original_tokens INTEGER NOT NULL,
  compressed_tokens INTEGER NOT NULL,
  original_chars INTEGER NOT NULL,
  compressed_chars INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retrieval_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ccr_session ON ccr_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_ccr_expires_at ON ccr_entries(expires_at);
`;

type Row = {
  hash: string;
  session_id: string;
  call_id: string | null;
  tool: string | null;
  strategy: string;
  original_content: string;
  compressed_content: string;
  original_tokens: number;
  compressed_tokens: number;
  original_chars: number;
  compressed_chars: number;
  created_at: number;
  expires_at: number;
  retrieval_count: number;
};

function rowToEntry(row: Row): CCREntry {
  return {
    hash: row.hash,
    sessionID: row.session_id,
    callID: row.call_id ?? undefined,
    tool: row.tool ?? undefined,
    strategy: row.strategy,
    originalContent: row.original_content,
    compressedContent: row.compressed_content,
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
  private db: InstanceType<DatabaseConstructor>;

  constructor(path: string, Database: DatabaseConstructor, private now: () => number = () => Date.now()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort privacy on platforms that support chmod.
    }
  }

  async put(input: CCRPutInput): Promise<CCREntry> {
    const createdAt = this.now();
    const entry: CCREntry = {
      hash: createContentHash(input.originalContent),
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
      .query(`INSERT OR REPLACE INTO ccr_entries
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
        entry.originalContent,
        entry.compressedContent,
        entry.originalTokens,
        entry.compressedTokens,
        entry.originalChars,
        entry.compressedChars,
        entry.createdAt,
        entry.expiresAt,
        entry.retrievalCount,
      );
    await this.pruneExpired();
    return { ...entry };
  }

  async get(hash: string): Promise<CCREntry | null> {
    const row = this.db.query<Row>("SELECT * FROM ccr_entries WHERE hash = ?").get(hash);
    if (!row) return null;
    if (row.expires_at <= this.now()) {
      this.db.query("DELETE FROM ccr_entries WHERE hash = ?").run(hash);
      return null;
    }
    this.db.query("UPDATE ccr_entries SET retrieval_count = retrieval_count + 1 WHERE hash = ?").run(hash);
    return { ...rowToEntry(row), retrievalCount: row.retrieval_count + 1 };
  }

  async stats(sessionID?: string): Promise<CCRStats> {
    await this.pruneExpired();
    const rows = sessionID
      ? this.db.query<Row>("SELECT * FROM ccr_entries WHERE session_id = ?").all(sessionID)
      : this.db.query<Row>("SELECT * FROM ccr_entries").all();
    return {
      entryCount: rows.length,
      totalOriginalTokens: rows.reduce((sum, row) => sum + row.original_tokens, 0),
      totalCompressedTokens: rows.reduce((sum, row) => sum + row.compressed_tokens, 0),
      totalTokensSaved: rows.reduce((sum, row) => sum + Math.max(0, row.original_tokens - row.compressed_tokens), 0),
      totalRetrievals: rows.reduce((sum, row) => sum + row.retrieval_count, 0),
    };
  }

  async pruneExpired(now: number = this.now()): Promise<number> {
    const expired = this.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM ccr_entries WHERE expires_at <= ?").get(now)?.count ?? 0;
    this.db.query("DELETE FROM ccr_entries WHERE expires_at <= ?").run(now);
    return expired;
  }
}

export async function createBunSQLiteStore(path: string): Promise<CCRStore> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const mod = (await dynamicImport("bun:sqlite")) as BunSQLiteModule;
  return new BunSQLiteCCRStore(path, mod.Database);
}
```

- [ ] **Step 4: Run store tests**

Run: `bun run test tests/store.test.ts`

Expected: PASS in Bun. In non-Bun Node, the explicit Bun SQLite test can fail because `bun:sqlite` is unavailable; the project execution environment is Bun per dependency install.

- [ ] **Step 5: Commit**

```bash
git add src/store/sqlite-bun.ts tests/store.test.ts
git commit -m "feat: add bun sqlite ccr store"
```

---

### Task 5: Router and Content Detection

**Files:**
- Create: `src/compressors/types.ts`
- Create: `src/engine/types.ts`
- Create: `src/engine/router.ts`
- Test: `tests/router.test.ts`

- [ ] **Step 1: Write failing router tests**

Create `tests/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectContentType, stripDetectionEnvelope } from "../src/engine/router.js";

describe("content router detection", () => {
  it("strips full tool output envelopes for detection only", () => {
    const wrapped = "<returncode>0</returncode>\n<output>\nsrc/a.ts:10:match\n</output>";
    expect(stripDetectionEnvelope(wrapped)).toBe("src/a.ts:10:match");
  });

  it("detects JSON arrays and objects", () => {
    expect(detectContentType('[{"id":1}]').kind).toBe("json");
    expect(detectContentType('{"id":1}').kind).toBe("json");
  });

  it("detects diff before search", () => {
    const diff = "diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n+src/a.ts:10:still diff";
    expect(detectContentType(diff).kind).toBe("diff");
  });

  it("detects search output", () => {
    const result = detectContentType("src/a.ts:10:const x = 1;\nsrc/a.ts:20:const y = 2;");
    expect(result.kind).toBe("search");
  });

  it("detects logs", () => {
    const result = detectContentType("2026-01-01 starting\nERROR failed\nWARNING retrying");
    expect(result.kind).toBe("log");
  });

  it("falls back to text", () => {
    expect(detectContentType("plain prose with no strong structure").kind).toBe("text");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun run test tests/router.test.ts`

Expected: FAIL with missing router module.

- [ ] **Step 3: Implement shared types**

Create `src/engine/types.ts`:

```ts
export interface ToolOutputCompressionInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
  output: string;
  ttlMs: number;
}

export interface ToolOutputCompressionResult {
  changed: boolean;
  output: string;
  strategy: string;
  hash?: string;
  originalTokens: number;
  compressedTokens: number;
  reason?: string;
}

export interface RetrieveResult {
  found: boolean;
  output: string;
}

export interface StatsResult {
  output: string;
}

export interface CompressionEngine {
  name: string;
  compress(input: ToolOutputCompressionInput): Promise<ToolOutputCompressionResult>;
  retrieve(hash: string, query?: string): Promise<RetrieveResult>;
  stats(sessionID?: string): Promise<StatsResult>;
}
```

Create `src/compressors/types.ts`:

```ts
export type ContentKind = "json" | "search" | "log" | "text" | "diff";

export interface DetectionResult {
  kind: ContentKind;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface CompressorInput {
  content: string;
  hash: string;
  query: string;
}

export interface CompressorResult {
  changed: boolean;
  output: string;
  strategy: ContentKind;
  reason?: string;
}
```

- [ ] **Step 4: Implement detection**

Create `src/engine/router.ts`:

```ts
import type { DetectionResult } from "../compressors/types.js";

const ENVELOPE_RE = /^\s*(?:<returncode>\s*-?\d+\s*<\/returncode>\s*)?<(?<tag>output|stdout|stderr|tool_result|result)>\n?(?<body>[\s\S]*?)\n?<\/\k<tag>>\s*$/;
const SEARCH_RE = /^[^\s:][^:\n]*[:\-]\d+[:\-]/;
const DIFF_HEADER_RE = /^(diff --git|diff --combined |diff --cc |--- a\/|@@\s+-\d+)/;
const DIFF_CHANGE_RE = /^[+-][^+-]/;
const LOG_PATTERNS = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /\b(WARN|WARNING)\b/i,
  /\b(INFO|DEBUG|TRACE)\b/i,
  /^\s*\d{4}-\d{2}-\d{2}/,
  /^\s*\[\d{2}:\d{2}:\d{2}\]/,
  /^npm ERR!|^yarn error|^cargo error/i,
  /Traceback \(most recent call last\)/,
  /^\s*at\s+[\w.$]+\(/,
];

export function stripDetectionEnvelope(content: string): string {
  const match = ENVELOPE_RE.exec(content);
  const body = match?.groups?.body;
  return body && body.trim() ? body.trim() : content;
}

export function detectContentType(content: string): DetectionResult {
  const probe = stripDetectionEnvelope(content);
  if (!probe.trim()) return { kind: "text", confidence: 0, metadata: {} };

  const trimmed = probe.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return { kind: "json", confidence: 1, metadata: {} };
    } catch {
      // Continue detection for invalid JSON-looking content.
    }
  }

  const firstLines = probe.split(/\r?\n/).slice(0, 500);
  const diffHeaders = firstLines.filter((line) => DIFF_HEADER_RE.test(line)).length;
  const diffChanges = firstLines.filter((line) => DIFF_CHANGE_RE.test(line)).length;
  if (diffHeaders > 0) {
    return {
      kind: "diff",
      confidence: Math.min(1, 0.5 + diffHeaders * 0.2 + diffChanges * 0.05),
      metadata: { diffHeaders, diffChanges },
    };
  }

  const searchLines = firstLines.slice(0, 100).filter((line) => line.trim());
  const searchMatches = searchLines.filter((line) => SEARCH_RE.test(line)).length;
  if (searchLines.length > 0 && searchMatches / searchLines.length >= 0.3) {
    return {
      kind: "search",
      confidence: Math.min(1, 0.4 + (searchMatches / searchLines.length) * 0.6),
      metadata: { matchingLines: searchMatches, totalLines: searchLines.length },
    };
  }

  const logLines = firstLines.slice(0, 200).filter((line) => line.trim());
  const logMatches = logLines.filter((line) => LOG_PATTERNS.some((pattern) => pattern.test(line))).length;
  if (logLines.length > 0 && logMatches / logLines.length >= 0.1) {
    return {
      kind: "log",
      confidence: Math.min(1, 0.3 + (logMatches / logLines.length) * 0.5),
      metadata: { matchingLines: logMatches, totalLines: logLines.length },
    };
  }

  return { kind: "text", confidence: 0.5, metadata: {} };
}
```

- [ ] **Step 5: Run router tests**

Run: `bun run test tests/router.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/types.ts src/compressors/types.ts src/engine/router.ts tests/router.test.ts
git commit -m "feat: add headroom compatible content detection"
```

---

### Task 6: JSON SmartCrusher-Lite

**Files:**
- Create: `src/compressors/json.ts`
- Test: `tests/json-compressor.test.ts`
- Test: `tests/fixtures.ts`

- [ ] **Step 1: Add JSON fixture and tests**

Create `tests/fixtures.ts`:

```ts
export function largeJsonArrayFixture(): string {
  const rows = Array.from({ length: 80 }, (_, index) => ({
    id: index + 1,
    level: index === 41 ? "ERROR" : "INFO",
    message: index === 41 ? "auth failed for token refresh" : `normal event ${index + 1}`,
    service: "api",
    region: "us-east-1",
  }));
  rows[25] = { ...rows[25], extra: "shape change" };
  return JSON.stringify(rows, null, 2);
}
```

Create `tests/json-compressor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createContentHash } from "../src/store/ccr.js";
import { compressJson } from "../src/compressors/json.js";
import { largeJsonArrayFixture } from "./fixtures.js";

describe("JSON SmartCrusher-lite", () => {
  it("keeps original rows and appends Headroom CCR sentinel", () => {
    const original = largeJsonArrayFixture();
    const hash = createContentHash(original);
    const result = compressJson({ content: original, hash, query: "auth error" });
    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("json");

    const parsed = JSON.parse(result.output) as Array<Record<string, unknown>>;
    expect(parsed[0]?.id).toBe(1);
    expect(parsed.some((row) => row.message === "auth failed for token refresh")).toBe(true);
    expect(parsed.some((row) => row.extra === "shape change")).toBe(true);
    expect(parsed.at(-1)).toEqual({
      _ccr_dropped: `<<ccr:${hash} 67_rows_offloaded>>`,
    });
    expect(result.output.length).toBeLessThan(original.length * 0.4);
  });

  it("passes invalid JSON through", () => {
    const result = compressJson({ content: "[not json", hash: "0123456789abcdef01234567", query: "" });
    expect(result.changed).toBe(false);
    expect(result.output).toBe("[not json");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun run test tests/json-compressor.test.ts`

Expected: FAIL with missing `compressJson`.

- [ ] **Step 3: Implement JSON compressor**

Create `src/compressors/json.ts`:

```ts
import { formatJsonSentinel } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

const PRIORITY_RE = /\b(error|fail|failed|fatal|critical|exception|warn|warning|todo|fixme|hack|auth|secret|password|security)\b/i;
const MAX_ITEMS_AFTER_CRUSH = 15;

function keySignature(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.keys(value as Record<string, unknown>).sort().join("\u0000");
}

function dominantSignature(rows: unknown[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const signature = keySignature(row);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function rowHasPriority(row: unknown, query: string): boolean {
  const text = JSON.stringify(row);
  if (PRIORITY_RE.test(text)) return true;
  const words = query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}

export function compressJson(input: CompressorInput): CompressorResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch {
    return { changed: false, output: input.content, strategy: "json", reason: "invalid_json" };
  }

  if (!Array.isArray(parsed) || parsed.length <= MAX_ITEMS_AFTER_CRUSH) {
    return { changed: false, output: input.content, strategy: "json", reason: "not_large_array" };
  }

  const dominant = dominantSignature(parsed);
  const selected = new Set<number>([0, parsed.length - 1]);
  parsed.forEach((row, index) => {
    if (keySignature(row) !== dominant) selected.add(index);
    if (rowHasPriority(row, input.query)) selected.add(index);
  });

  for (let index = 0; index < parsed.length && selected.size < MAX_ITEMS_AFTER_CRUSH; index += 1) {
    selected.add(index);
  }

  const keptIndexes = [...selected].sort((a, b) => a - b).slice(0, MAX_ITEMS_AFTER_CRUSH);
  const keptRows = keptIndexes.map((index) => parsed[index]);
  const dropped = parsed.length - keptRows.length;
  if (dropped <= 0) {
    return { changed: false, output: input.content, strategy: "json", reason: "nothing_dropped" };
  }

  const output = JSON.stringify([...keptRows, formatJsonSentinel(input.hash, dropped)], null, 2);
  if (output.length >= input.content.length) {
    return { changed: false, output: input.content, strategy: "json", reason: "no_savings" };
  }
  return { changed: true, output, strategy: "json" };
}
```

- [ ] **Step 4: Run JSON tests**

Run: `bun run test tests/json-compressor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compressors/json.ts tests/json-compressor.test.ts tests/fixtures.ts
git commit -m "feat: add smartcrusher lite json compressor"
```

---

### Task 7: Search Compressor

**Files:**
- Create: `src/compressors/search.ts`
- Modify: `tests/fixtures.ts`
- Test: `tests/search-compressor.test.ts`

- [ ] **Step 1: Add search fixture and tests**

Append to `tests/fixtures.ts`:

```ts
export function searchFixture(): string {
  const auth = Array.from({ length: 70 }, (_, index) =>
    `src/auth.ts:${index + 1}:${index === 34 ? "ERROR auth token rejected" : `auth event ${index + 1}`}`,
  );
  const db = Array.from({ length: 40 }, (_, index) =>
    `src/db.ts:${index + 1}:db query ${index + 1}`,
  );
  return [...auth, ...db].join("\n");
}
```

Create `tests/search-compressor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createContentHash } from "../src/store/ccr.js";
import { compressSearch, parseSearchResults } from "../src/compressors/search.js";
import { searchFixture } from "./fixtures.js";

describe("search compressor", () => {
  it("parses grep and rg context lines", () => {
    const parsed = parseSearchResults("src/a.ts:10:match\nsrc/a.ts-11-context");
    expect(parsed).toEqual([
      { file: "src/a.ts", lineNumber: 10, content: "match" },
      { file: "src/a.ts", lineNumber: 11, content: "context" },
    ]);
  });

  it("keeps line numbers, priority matches, summaries, and retrieve marker", () => {
    const original = searchFixture();
    const hash = createContentHash(original);
    const result = compressSearch({ content: original, hash, query: "auth error" });
    expect(result.changed).toBe(true);
    expect(result.output).toContain("src/auth.ts:35:ERROR auth token rejected");
    expect(result.output).toContain("[... and");
    expect(result.output).toContain(`[Retrieve more: hash=${hash}]`);
    expect(result.output.length).toBeLessThan(original.length * 0.3);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun run test tests/search-compressor.test.ts`

Expected: FAIL with missing search compressor.

- [ ] **Step 3: Implement search compressor**

Create `src/compressors/search.ts`:

```ts
import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

export interface SearchMatch {
  file: string;
  lineNumber: number;
  content: string;
}

const MATCH_RE = /^(?<file>.+?)(?<sep>[:\-])(?<line>\d+)\k<sep>(?<content>.*)$/;
const PRIORITY_RE = /\b(error|fail|failed|fatal|critical|exception|warn|warning|todo|fixme|hack|auth|secret|password|security)\b/i;

export function parseSearchResults(content: string): SearchMatch[] {
  return content
    .split(/\r?\n/)
    .map((line) => MATCH_RE.exec(line))
    .filter((match): match is RegExpExecArray & { groups: Record<string, string> } => Boolean(match?.groups))
    .map((match) => ({
      file: match.groups.file,
      lineNumber: Number(match.groups.line),
      content: match.groups.content,
    }));
}

function scoreMatch(match: SearchMatch, query: string): number {
  let score = 0;
  if (PRIORITY_RE.test(match.content)) score += 1;
  const lower = match.content.toLowerCase();
  for (const word of query.toLowerCase().split(/\W+/).filter((part) => part.length > 2)) {
    if (lower.includes(word)) score += 0.3;
  }
  return score;
}

export function compressSearch(input: CompressorInput): CompressorResult {
  const matches = parseSearchResults(input.content);
  if (matches.length < 20) {
    return { changed: false, output: input.content, strategy: "search", reason: "too_few_matches" };
  }

  const byFile = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const list = byFile.get(match.file) ?? [];
    list.push(match);
    byFile.set(match.file, list);
  }

  const selected: SearchMatch[] = [];
  const summaries: string[] = [];
  for (const [file, fileMatches] of [...byFile.entries()].slice(0, 15)) {
    const keep = new Map<number, SearchMatch>();
    keep.set(fileMatches[0]!.lineNumber, fileMatches[0]!);
    keep.set(fileMatches.at(-1)!.lineNumber, fileMatches.at(-1)!);
    const scored = [...fileMatches].sort((a, b) => scoreMatch(b, input.query) - scoreMatch(a, input.query));
    for (const match of scored) {
      if (keep.size >= 5) break;
      keep.set(match.lineNumber, match);
    }
    const kept = [...keep.values()].sort((a, b) => a.lineNumber - b.lineNumber);
    selected.push(...kept);
    const omitted = fileMatches.length - kept.length;
    if (omitted > 0) summaries.push(`[... and ${omitted} more matches in ${file}]`);
  }

  selected.sort((a, b) => a.file.localeCompare(b.file) || a.lineNumber - b.lineNumber);
  const output = [
    ...selected.slice(0, 30).map((match) => `${match.file}:${match.lineNumber}:${match.content}`),
    ...summaries,
    formatRetrieveMarker(input.hash),
  ].join("\n");

  if (output.length >= input.content.length) {
    return { changed: false, output: input.content, strategy: "search", reason: "no_savings" };
  }
  return { changed: true, output, strategy: "search" };
}
```

- [ ] **Step 4: Run search tests**

Run: `bun run test tests/search-compressor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compressors/search.ts tests/search-compressor.test.ts tests/fixtures.ts
git commit -m "feat: add headroom style search compressor"
```

---

### Task 8: Log Compressor

**Files:**
- Create: `src/compressors/log.ts`
- Modify: `tests/fixtures.ts`
- Test: `tests/log-compressor.test.ts`

- [ ] **Step 1: Add log fixture and tests**

Append to `tests/fixtures.ts`:

```ts
export function logFixture(): string {
  const info = Array.from({ length: 100 }, (_, index) => `INFO processing item ${index + 1}`);
  return [
    "============================= test session starts =============================",
    ...info.slice(0, 40),
    "WARNING auth retry scheduled",
    "ERROR critical auth failure",
    "Traceback (most recent call last)",
    "  File \"app.py\", line 10, in main",
    "ValueError: token rejected",
    ...info.slice(40),
    "2 failed, 1 warning",
  ].join("\n");
}
```

Create `tests/log-compressor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createContentHash } from "../src/store/ccr.js";
import { classifyLogLine, compressLog, detectLogFormat } from "../src/compressors/log.js";
import { logFixture } from "./fixtures.js";

describe("log compressor", () => {
  it("classifies levels and formats", () => {
    expect(classifyLogLine("ERROR bad").level).toBe("ERROR");
    expect(classifyLogLine("npm ERR! bad").level).toBe("ERROR");
    expect(detectLogFormat(["npm ERR! bad"])).toBe("npm");
    expect(detectLogFormat(["PASS src/a.test.ts", "Test Suites: 1 failed"])).toBe("jest");
  });

  it("keeps errors, stack traces, summaries, and retrieve marker", () => {
    const original = logFixture();
    const hash = createContentHash(original);
    const result = compressLog({ content: original, hash, query: "auth failure" });
    expect(result.changed).toBe(true);
    expect(result.output).toContain("ERROR critical auth failure");
    expect(result.output).toContain("Traceback (most recent call last)");
    expect(result.output).toContain("2 failed, 1 warning");
    expect(result.output).toContain(`[Retrieve more: hash=${hash}]`);
    expect(result.output.length).toBeLessThan(original.length * 0.5);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun run test tests/log-compressor.test.ts`

Expected: FAIL with missing log compressor.

- [ ] **Step 3: Implement log compressor**

Create `src/compressors/log.ts`:

```ts
import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

export type LogLevel = "ERROR" | "FAIL" | "WARN" | "INFO" | "DEBUG" | "TRACE" | "UNKNOWN";
export type LogFormat = "pytest" | "npm" | "cargo" | "make" | "jest" | "generic";

export interface ClassifiedLogLine {
  index: number;
  content: string;
  level: LogLevel;
  stackTrace: boolean;
  summary: boolean;
}

export function classifyLogLine(content: string, index = 0): ClassifiedLogLine {
  const level: LogLevel =
    /\b(ERROR|FATAL|CRITICAL)\b|^npm ERR!/i.test(content) ? "ERROR" :
    /\b(FAIL|FAILED)\b/i.test(content) ? "FAIL" :
    /\b(WARN|WARNING)\b/i.test(content) ? "WARN" :
    /\bINFO\b/i.test(content) ? "INFO" :
    /\bDEBUG\b/i.test(content) ? "DEBUG" :
    /\bTRACE\b/i.test(content) ? "TRACE" :
    "UNKNOWN";
  return {
    index,
    content,
    level,
    stackTrace: /Traceback \(most recent call last\)|^\s*File ".+", line \d+|^\s*at\s+[\w.$]+\(|^\s+at [\w.$]+\(/.test(content),
    summary: /^={3,}|^-{3,}|\d+ (passed|failed|skipped|warning)|^(Tests?|Suites?):/i.test(content),
  };
}

export function detectLogFormat(lines: string[]): LogFormat {
  const text = lines.join("\n");
  if (/npm ERR!|npm WARN/.test(text)) return "npm";
  if (/pytest|test session starts|\d+ failed/i.test(text)) return "pytest";
  if (/cargo|Compiling .+|warning:/.test(text)) return "cargo";
  if (/make: \*\*\*/.test(text)) return "make";
  if (/Test Suites:|PASS |FAIL /.test(text)) return "jest";
  return "generic";
}

export function compressLog(input: CompressorInput): CompressorResult {
  const lines = input.content.split(/\r?\n/);
  if (lines.length < 50) {
    return { changed: false, output: input.content, strategy: "log", reason: "too_few_lines" };
  }
  const classified = lines.map((line, index) => classifyLogLine(line, index));
  const selected = new Set<number>();

  for (const line of classified) {
    if (line.level === "ERROR" || line.level === "FAIL" || line.summary || line.stackTrace) selected.add(line.index);
    if (line.level === "WARN" && [...selected].filter((idx) => classified[idx]?.level === "WARN").length < 5) selected.add(line.index);
  }

  const important = [...selected];
  for (const index of important) {
    selected.add(Math.max(0, index - 1));
    selected.add(Math.min(lines.length - 1, index + 1));
  }

  const kept = [...selected].sort((a, b) => a - b).slice(0, 100);
  const stats = {
    errors: classified.filter((line) => line.level === "ERROR").length,
    fails: classified.filter((line) => line.level === "FAIL").length,
    warnings: classified.filter((line) => line.level === "WARN").length,
    info: classified.filter((line) => line.level === "INFO").length,
  };
  const omitted = lines.length - kept.length;
  const parts = kept.map((index) => lines[index]!);
  if (omitted > 0) {
    const labels = [
      stats.errors ? `${stats.errors} ERROR` : "",
      stats.fails ? `${stats.fails} FAIL` : "",
      stats.warnings ? `${stats.warnings} WARN` : "",
      stats.info ? `${stats.info} INFO` : "",
    ].filter(Boolean);
    parts.push(`[${omitted} lines omitted: ${labels.join(", ")}]`);
  }
  parts.push(formatRetrieveMarker(input.hash));
  const output = parts.join("\n");
  if (output.length >= input.content.length) {
    return { changed: false, output: input.content, strategy: "log", reason: "no_savings" };
  }
  return { changed: true, output, strategy: "log" };
}
```

- [ ] **Step 4: Run log tests**

Run: `bun run test tests/log-compressor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compressors/log.ts tests/log-compressor.test.ts tests/fixtures.ts
git commit -m "feat: add headroom style log compressor"
```

---

### Task 9: Extractive Text Compressor

**Files:**
- Create: `src/compressors/text.ts`
- Modify: `tests/fixtures.ts`
- Test: `tests/text-compressor.test.ts`

- [ ] **Step 1: Add text fixture and tests**

Append to `tests/fixtures.ts`:

```ts
export function textFixture(): string {
  return [
    "# Build Report",
    "The build processed many modules successfully.",
    ...Array.from({ length: 60 }, (_, index) => `Module ${index + 1} completed with routine output.`),
    "Security warning: auth token rotation is required.",
    "Action required: fix retry backoff before release.",
    "The final deployment summary is ready.",
  ].join("\n\n");
}
```

Create `tests/text-compressor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createContentHash } from "../src/store/ccr.js";
import { compressText, splitTextSegments } from "../src/compressors/text.js";
import { textFixture } from "./fixtures.js";

describe("extractive text compressor", () => {
  it("splits useful text segments", () => {
    expect(splitTextSegments("A.\n\nB.")).toEqual(["A.", "B."]);
  });

  it("keeps only original segments and appends retrieve marker", () => {
    const original = textFixture();
    const hash = createContentHash(original);
    const result = compressText({ content: original, hash, query: "security auth" });
    expect(result.changed).toBe(true);
    expect(result.output).toContain("# Build Report");
    expect(result.output).toContain("Security warning: auth token rotation is required.");
    expect(result.output).toContain(`[Retrieve more: hash=${hash}]`);

    for (const segment of result.output.split(/\n\n+/).filter((part) => !part.startsWith("[Retrieve"))) {
      expect(original).toContain(segment);
    }
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun run test tests/text-compressor.test.ts`

Expected: FAIL with missing text compressor.

- [ ] **Step 3: Implement extractive text compressor**

Create `src/compressors/text.ts`:

```ts
import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

const PRIORITY_RE = /^(#|##|###)|\b(error|fail|failed|fatal|critical|warning|todo|fixme|auth|secret|password|security)\b/i;

export function splitTextSegments(content: string): string[] {
  return content
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z#])/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 2);
}

function normalize(segment: string): string {
  return segment.toLowerCase().replace(/\d+/g, "N").replace(/\s+/g, " ").trim();
}

export function compressText(input: CompressorInput): CompressorResult {
  const segments = splitTextSegments(input.content);
  if (segments.length < 8) {
    return { changed: false, output: input.content, strategy: "text", reason: "too_few_segments" };
  }

  const selected = new Set<number>([0, segments.length - 1]);
  const queryWords = input.query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
  segments.forEach((segment, index) => {
    const lower = segment.toLowerCase();
    if (PRIORITY_RE.test(segment)) selected.add(index);
    if (queryWords.some((word) => lower.includes(word))) selected.add(index);
  });
  for (let index = 0; index < segments.length && selected.size < 12; index += 1) selected.add(index);

  const seen = new Set<string>();
  const kept = [...selected]
    .sort((a, b) => a - b)
    .map((index) => segments[index]!)
    .filter((segment) => {
      const key = normalize(segment);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const output = [...kept, formatRetrieveMarker(input.hash)].join("\n\n");
  if (output.length >= input.content.length) {
    return { changed: false, output: input.content, strategy: "text", reason: "no_savings" };
  }
  return { changed: true, output, strategy: "text" };
}
```

- [ ] **Step 4: Run text tests**

Run: `bun run test tests/text-compressor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compressors/text.ts tests/text-compressor.test.ts tests/fixtures.ts
git commit -m "feat: add extractive text compressor"
```

---

### Task 10: Native Engine Orchestration

**Files:**
- Create: `src/engine/native.ts`
- Modify: `src/engine/router.ts`
- Test: `tests/native-engine.test.ts`

- [ ] **Step 1: Write failing native engine tests**

Create `tests/native-engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { largeJsonArrayFixture, searchFixture } from "./fixtures.js";

describe("native engine", () => {
  it("compresses and stores original output", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const original = largeJsonArrayFixture();
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "cat data.json" },
      output: original,
      ttlMs: 60_000,
    });

    expect(result.changed).toBe(true);
    expect(result.hash).toMatch(/^[a-f0-9]{24}$/);
    expect(await engine.retrieve(result.hash!)).toEqual({ found: true, output: original });
  });

  it("does not store when compression has no savings", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: {},
      output: "small",
      ttlMs: 60_000,
    });
    expect(result.changed).toBe(false);
    expect((await store.stats()).entryCount).toBe(0);
  });

  it("reports stats", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "rg auth" },
      output: searchFixture(),
      ttlMs: 60_000,
    });
    const stats = await engine.stats("s1");
    expect(stats.output).toContain("entries: 1");
    expect(stats.output).toContain("tokens saved");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun run test tests/native-engine.test.ts`

Expected: FAIL with missing native engine.

- [ ] **Step 3: Add router compression function**

Append to `src/engine/router.ts`:

```ts
import type { CompressorInput, CompressorResult } from "../compressors/types.js";
import { compressJson } from "../compressors/json.js";
import { compressSearch } from "../compressors/search.js";
import { compressLog } from "../compressors/log.js";
import { compressText } from "../compressors/text.js";

export function compressByContentType(input: CompressorInput): CompressorResult {
  const detection = detectContentType(input.content);
  if (detection.kind === "diff") {
    return { changed: false, output: input.content, strategy: "diff", reason: "diff_passthrough" };
  }
  if (detection.kind === "json") return compressJson(input);
  if (detection.kind === "search") return compressSearch(input);
  if (detection.kind === "log") return compressLog(input);
  return compressText(input);
}
```

- [ ] **Step 4: Implement native engine**

Create `src/engine/native.ts`:

```ts
import { containsCCRMarker } from "../markers.js";
import { estimateTokens } from "../token.js";
import { createContentHash } from "../store/ccr.js";
import type { CCRStore } from "../store/types.js";
import { compressByContentType } from "./router.js";
import type {
  CompressionEngine,
  RetrieveResult,
  StatsResult,
  ToolOutputCompressionInput,
  ToolOutputCompressionResult,
} from "./types.js";

function queryFromArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.values(args as Record<string, unknown>)
    .filter((value) => ["string", "number", "boolean"].includes(typeof value))
    .join(" ")
    .slice(0, 300);
}

export class NativeHeadroomCompatibleEngine implements CompressionEngine {
  name = "native";

  constructor(private store: CCRStore) {}

  async compress(input: ToolOutputCompressionInput): Promise<ToolOutputCompressionResult> {
    const originalTokens = estimateTokens(input.output);
    if (!input.output.trim() || containsCCRMarker(input.output)) {
      return {
        changed: false,
        output: input.output,
        strategy: "passthrough",
        originalTokens,
        compressedTokens: originalTokens,
        reason: "empty_or_marked",
      };
    }

    const hash = createContentHash(input.output);
    const compressed = compressByContentType({
      content: input.output,
      hash,
      query: queryFromArgs(input.args),
    });
    const compressedTokens = estimateTokens(compressed.output);
    if (!compressed.changed || compressedTokens >= originalTokens) {
      return {
        changed: false,
        output: input.output,
        strategy: compressed.strategy,
        originalTokens,
        compressedTokens: originalTokens,
        reason: compressed.reason ?? "no_savings",
      };
    }

    const entry = await this.store.put({
      sessionID: input.sessionID,
      callID: input.callID,
      tool: input.tool,
      strategy: compressed.strategy,
      originalContent: input.output,
      compressedContent: compressed.output,
      originalTokens,
      compressedTokens,
      ttlMs: input.ttlMs,
    });

    return {
      changed: true,
      output: compressed.output,
      strategy: compressed.strategy,
      hash: entry.hash,
      originalTokens,
      compressedTokens,
    };
  }

  async retrieve(hash: string): Promise<RetrieveResult> {
    const entry = await this.store.get(hash);
    if (!entry) {
      return {
        found: false,
        output: "Entry not found or expired. To recover command output, re-run the command. To recover file output, re-read the file. CCR entries expire after the configured TTL.",
      };
    }
    return { found: true, output: entry.originalContent };
  }

  async stats(sessionID?: string): Promise<StatsResult> {
    const stats = await this.store.stats(sessionID);
    return {
      output: [
        `engine: ${this.name}`,
        `entries: ${stats.entryCount}`,
        `original tokens: ${stats.totalOriginalTokens}`,
        `compressed tokens: ${stats.totalCompressedTokens}`,
        `tokens saved: ${stats.totalTokensSaved}`,
        `retrievals: ${stats.totalRetrievals}`,
      ].join("\n"),
    };
  }
}
```

- [ ] **Step 5: Run engine tests**

Run: `bun run test tests/native-engine.test.ts`

Expected: PASS.

- [ ] **Step 6: Run compressor suite**

Run: `bun run test tests/router.test.ts tests/json-compressor.test.ts tests/search-compressor.test.ts tests/log-compressor.test.ts tests/text-compressor.test.ts tests/native-engine.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/engine/native.ts src/engine/router.ts tests/native-engine.test.ts
git commit -m "feat: add native headroom compatible engine"
```

---

### Task 11: Native Tools

**Files:**
- Create: `src/tools/retrieve.ts`
- Create: `src/tools/stats.ts`
- Test: `tests/plugin.test.ts`

- [ ] **Step 1: Write failing tool tests**

Create `tests/plugin.test.ts` with initial tool tests:

```ts
import { describe, expect, it } from "vitest";
import { MemoryCCRStore } from "../src/store/memory.js";
import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { createRetrieveTool } from "../src/tools/retrieve.js";
import { createStatsTool } from "../src/tools/stats.js";

describe("native tools", () => {
  it("retrieve tool validates hash", async () => {
    const engine = new NativeHeadroomCompatibleEngine(new MemoryCCRStore());
    const retrieve = createRetrieveTool(engine);
    const result = await retrieve.execute({ hash: "bad" }, {} as never);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("Invalid hash");
  });

  it("stats tool returns session stats", async () => {
    const engine = new NativeHeadroomCompatibleEngine(new MemoryCCRStore());
    const stats = createStatsTool(engine);
    const result = await stats.execute({ sessionOnly: true }, { sessionID: "s1" } as never);
    const output = typeof result === "string" ? result : result.output;
    expect(output).toContain("engine: native");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun run test tests/plugin.test.ts`

Expected: FAIL with missing tool modules.

- [ ] **Step 3: Implement retrieve tool**

Create `src/tools/retrieve.ts`:

```ts
import { tool } from "@opencode-ai/plugin";
import { z } from "zod/v4";
import type { CompressionEngine } from "../engine/types.js";
import { isValidCCRHash } from "../markers.js";

export function createRetrieveTool(engine: CompressionEngine) {
  return tool({
    description:
      "Retrieve exact original content from opencode-headroom CCR by 24-character hash. Use when compressed tool output contains a CCR or Retrieve marker.",
    args: {
      hash: z.string().describe("24-character CCR hash from a compressed tool output marker"),
      query: z.string().optional().describe("Optional reason or search query for retrieval stats"),
    },
    async execute(args: { hash: string; query?: string }) {
      if (!isValidCCRHash(args.hash)) {
        return "Invalid hash format. Expected 24 hex characters.";
      }
      const result = await engine.retrieve(args.hash, args.query);
      return result.output;
    },
  });
}
```

- [ ] **Step 4: Implement stats tool**

Create `src/tools/stats.ts`:

```ts
import { tool } from "@opencode-ai/plugin";
import { z } from "zod/v4";
import type { CompressionEngine } from "../engine/types.js";

export function createStatsTool(engine: CompressionEngine) {
  return tool({
    description: "Show opencode-headroom compression and CCR statistics for this session or all active entries.",
    args: {
      sessionOnly: z.boolean().optional().describe("When true, only show stats for the current OpenCode session"),
    },
    async execute(args: { sessionOnly?: boolean }, context) {
      const sessionID = args.sessionOnly ? context.sessionID : undefined;
      const result = await engine.stats(sessionID);
      return result.output;
    },
  });
}
```

- [ ] **Step 5: Run tool tests**

Run: `bun run test tests/plugin.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools tests/plugin.test.ts
git commit -m "feat: add retrieve and stats native tools"
```

---

### Task 12: OpenCode Plugin Hook

**Files:**
- Create: `src/plugin.ts`
- Modify: `tests/plugin.test.ts`

- [ ] **Step 1: Add plugin hook tests**

Append to `tests/plugin.test.ts`:

```ts
import { HeadroomNativePlugin } from "../src/plugin.js";
import { searchFixture } from "./fixtures.js";

function pluginInput() {
  return {
    client: {},
    project: { id: "project-1" },
    directory: "/repo",
    worktree: "/repo",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {},
  } as never;
}

describe("OpenCode plugin", () => {
  it("registers after hook and tools", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), { storage: { kind: "memory" } });
    expect(plugin.tool?.headroom_retrieve).toBeDefined();
    expect(plugin.tool?.headroom_stats).toBeDefined();
    expect(plugin["tool.execute.after"]).toBeTypeOf("function");
  });

  it("compresses large tool output after execution", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const output = { title: "Bash", output: searchFixture(), metadata: {} };
    await plugin["tool.execute.after"]!(
      { tool: "Bash", sessionID: "s1", callID: "c1", args: { command: "rg auth" } },
      output,
    );
    expect(output.output).toContain("[Retrieve more: hash=");
    expect(output.metadata.headroom.strategy).toBe("search");
  });

  it("skips ctx tools", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const original = searchFixture();
    const output = { title: "ctx_search", output: original, metadata: {} };
    await plugin["tool.execute.after"]!(
      { tool: "ctx_search", sessionID: "s1", callID: "c1", args: {} },
      output,
    );
    expect(output.output).toBe(original);
  });
});
```

- [ ] **Step 2: Run plugin tests to verify failure**

Run: `bun run test tests/plugin.test.ts`

Expected: FAIL with missing `src/plugin.ts`.

- [ ] **Step 3: Implement plugin**

Create `src/plugin.ts`:

```ts
import type { Plugin } from "@opencode-ai/plugin";
import { normalizeConfig, shouldSkipTool, type HeadroomPluginOptions } from "./config.js";
import { estimateTokens } from "./token.js";
import { containsCCRMarker } from "./markers.js";
import { createCCRStore } from "./store/ccr.js";
import { NativeHeadroomCompatibleEngine } from "./engine/native.js";
import { createRetrieveTool } from "./tools/retrieve.js";
import { createStatsTool } from "./tools/stats.js";

export type { HeadroomPluginOptions } from "./config.js";

export const HeadroomNativePlugin: Plugin = async (_input, options = {}) => {
  const config = normalizeConfig(options as HeadroomPluginOptions);
  const store = await createCCRStore(config.storage);
  const engine = new NativeHeadroomCompatibleEngine(store);

  return {
    tool: {
      headroom_retrieve: createRetrieveTool(engine),
      headroom_stats: createStatsTool(engine),
    },
    "tool.execute.after": async (input, output) => {
      try {
        if (shouldSkipTool(input.tool, config)) return;
        if (!output.output || containsCCRMarker(output.output)) return;
        if (output.output.length > config.maxOutputChars) return;
        const tokens = estimateTokens(output.output);
        if (output.output.length < config.thresholdChars && tokens < config.thresholdTokens) return;

        const result = await engine.compress({
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          args: input.args,
          output: output.output,
          ttlMs: config.ttlHours * 60 * 60 * 1000,
        });
        if (!result.changed) return;

        output.output = result.output;
        output.metadata = {
          ...(output.metadata ?? {}),
          headroom: {
            engine: engine.name,
            strategy: result.strategy,
            hash: result.hash,
            originalTokens: result.originalTokens,
            compressedTokens: result.compressedTokens,
            tokensSaved: Math.max(0, result.originalTokens - result.compressedTokens),
          },
        };
      } catch {
        return;
      }
    },
  };
};

export default HeadroomNativePlugin;
```

- [ ] **Step 4: Run plugin tests**

Run: `bun run test tests/plugin.test.ts`

Expected: PASS.

- [ ] **Step 5: Run full unit suite**

Run: `bun run test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/plugin.ts tests/plugin.test.ts
git commit -m "feat: add native opencode plugin hook"
```

---

### Task 13: Example Config and Design Pointer

**Files:**
- Create: `opencode.json.example`
- Create: `DESIGN.md`
- Modify: `src/index.ts`

- [ ] **Step 1: Write example config**

Create `opencode.json.example`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-headroom", {
      "engine": "native",
      "thresholdTokens": 2000,
      "thresholdChars": 8000,
      "ttlHours": 24,
      "storage": {
        "kind": "auto",
        "path": ".headroom/ccr.sqlite"
      },
      "skipTools": ["headroom_*", "ctx_*"]
    }]
  ]
}
```

- [ ] **Step 2: Write short design pointer**

Create `DESIGN.md`:

```md
# opencode-headroom Design

This package is a Headroom-compatible native OpenCode plugin.

P0 is fully native:

- no provider `baseURL` changes
- no transport patching
- no Headroom proxy sidecar
- no Python/Rust runtime dependency
- no Kompress/ML

The detailed approved design is in:

`docs/superpowers/specs/2026-07-06-opencode-headroom-native-design.md`
```

- [ ] **Step 3: Ensure exports are complete**

Update `src/index.ts`:

```ts
export { default, HeadroomNativePlugin } from "./plugin.js";
export type { HeadroomPluginOptions } from "./config.js";
export type {
  CompressionEngine,
  ToolOutputCompressionInput,
  ToolOutputCompressionResult,
} from "./engine/types.js";
export { NativeHeadroomCompatibleEngine } from "./engine/native.js";
export { createContentHash, createCCRStore } from "./store/ccr.js";
export type { CCRStore, CCREntry, CCRStats } from "./store/types.js";
```

- [ ] **Step 4: Run typecheck and tests**

Run: `bun run typecheck`

Expected: PASS.

Run: `bun run test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add opencode.json.example DESIGN.md src/index.ts
git commit -m "docs: add opencode headroom usage docs"
```

---

### Task 14: Verification and Acceptance

**Files:**
- Modify only files needed to fix failures found during verification.

- [ ] **Step 1: Run full verification**

Run: `bun run typecheck`

Expected: PASS.

Run: `bun run test`

Expected: PASS.

Run: `bun run build`

Expected: PASS and `dist/` contains compiled files.

- [ ] **Step 2: Inspect git status**

Run: `git status --short`

Expected: only intentional changes remain. `headroom/` and `target.md` may still be untracked reference inputs; do not add them unless explicitly requested.

- [ ] **Step 3: Manual acceptance checklist**

Confirm by reading changed code and test output:

- `src/plugin.ts` does not set provider config or `baseURL`.
- `src/plugin.ts` does not patch `fetch`, `http`, `https`, `NODE_OPTIONS`, or child process APIs.
- `package.json` has no `headroom-ai`, Python, Rust, or ML dependency.
- `headroom_retrieve` returns exact original content for emitted markers.
- `ctx_*` and `headroom_*` tools are skipped by default.

- [ ] **Step 4: Commit verification fixes if any**

If Step 1 required fixes:

```bash
git add src tests package.json tsconfig.json vitest.config.ts opencode.json.example DESIGN.md
git commit -m "test: verify native opencode headroom plugin"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review Notes

Spec coverage:

- Root npm package: Task 1.
- Native-only P0 and no proxy/provider changes: Tasks 12 and 14.
- Engine abstraction: Tasks 5 and 10.
- CCR store, hash, TTL, stats: Tasks 3 and 4.
- JSON/search/log/text Headroom-compatible compressors: Tasks 6 through 9.
- Native retrieve/stats tools: Task 11.
- OpenCode after-hook behavior and skip rules: Task 12.
- Example config and docs: Task 13.
- Verification: Task 14.

No task changes `headroom/`. The plan keeps Headroom-backed engines out of P0 while preserving the `CompressionEngine` extension point.
