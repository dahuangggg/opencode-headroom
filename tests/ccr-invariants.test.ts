import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { formatRetrieveMarker } from "../src/markers.js";
import {
  createCollisionHash,
  createContentDigest,
  createContentHash,
  type CCRHashProvider,
} from "../src/store/ccr.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import type { CCRStore } from "../src/store/types.js";

interface MarkerInvariantResult {
  firstHash: string;
  secondHash: string;
  secondOutput: string;
  secondOriginal: string;
  retrievedOriginal: string | null;
}

interface SessionInvariantResult {
  ownerFound: boolean;
  ownerOutput: string;
  otherFound: boolean;
  retrievals: number;
}

interface RetentionInvariantResult {
  releasedHashReused: boolean;
  expiredFound: boolean;
  retainedExpiredOriginal: boolean;
  historyEntryCount: number;
}

interface CapacityInvariantResult {
  expiredFound: boolean;
  oldestSurvivedExpiredPrune: boolean;
  oldestFoundAfterOverflow: boolean;
  middleFound: boolean;
  newestFound: boolean;
  entryCount: number;
}

interface DeleteSessionInvariantResult {
  removed: number;
  deletedSessionEntries: number;
  deletedOriginalFound: boolean;
  otherCollisionFound: boolean;
  sharedOtherSessionFound: boolean;
  releasedHashReused: boolean;
}

interface CloseInvariantResult {
  firstCloseSucceeded: boolean;
  secondCloseSucceeded: boolean;
}

function collisionContents(): { first: string; second: string } {
  const suffix = Array.from(
    { length: 100 },
    (_, index) => `repeat line ${index % 3}`,
  ).join("\n");
  return {
    first: `forced-collision-first\n${suffix}`,
    second: `forced-collision-second\n${suffix}`,
  };
}

function forcedCollisionHashing(): CCRHashProvider {
  return {
    contentHash: (content) =>
      content.startsWith("forced-collision-")
        ? "0".repeat(24)
        : createContentHash(content),
    contentDigest: createContentDigest,
    collisionHash: createCollisionHash,
  };
}

async function observeMarkerInvariant(
  store: CCRStore,
): Promise<MarkerInvariantResult> {
  const engine = new NativeHeadroomCompatibleEngine(store);
  const contents = collisionContents();
  const first = await engine.compress({
    tool: "Bash",
    sessionID: "session-1",
    callID: "call-1",
    args: {},
    output: contents.first,
    ttlMs: 60_000,
  });
  const second = await engine.compress({
    tool: "Bash",
    sessionID: "session-1",
    callID: "call-2",
    args: {},
    output: contents.second,
    ttlMs: 60_000,
  });
  const retrieved = await engine.retrieve(second.hash!, { mode: "full" });

  return {
    firstHash: first.hash!,
    secondHash: second.hash!,
    secondOutput: second.output,
    secondOriginal: contents.second,
    retrievedOriginal: retrieved.found ? retrieved.output : null,
  };
}

async function observeSessionInvariant(
  store: CCRStore,
): Promise<SessionInvariantResult> {
  const original = "private output for session-1";
  const entry = await store.put({
    sessionID: "session-1",
    callID: "call-1",
    tool: "Bash",
    strategy: "text",
    originalContent: original,
    compressedContent: "compressed",
    originalTokens: 5,
    compressedTokens: 1,
    ttlMs: 60_000,
  });
  const engine = new NativeHeadroomCompatibleEngine(store);
  const other = await engine.retrieve(entry.hash, { mode: "full" }, "session-2");
  const owner = await engine.retrieve(entry.hash, { mode: "full" }, "session-1");

  return {
    ownerFound: owner.found,
    ownerOutput: owner.output,
    otherFound: other.found,
    retrievals: (await store.stats("session-1")).totalRetrievals,
  };
}

async function observeRetentionInvariant(): Promise<RetentionInvariantResult> {
  let now = 1_000;
  const store = new MemoryCCRStore(
    () => now,
    {},
    undefined,
    forcedCollisionHashing(),
  );
  const contents = collisionContents();
  const first = await store.put({
    sessionID: "session-1",
    callID: "call-1",
    tool: "Bash",
    strategy: "text",
    originalContent: contents.first,
    compressedContent: "first",
    originalTokens: 10,
    compressedTokens: 1,
    ttlMs: 1,
  });

  now = 1_002;
  await store.pruneExpired();

  const second = await store.put({
    sessionID: "session-2",
    callID: "call-2",
    tool: "Bash",
    strategy: "text",
    originalContent: contents.second,
    compressedContent: "second",
    originalTokens: 10,
    compressedTokens: 1,
    ttlMs: 60_000,
  });
  const hashHistory = (
    store as unknown as { hashHistory: Map<string, Set<string>> }
  ).hashHistory;

  return {
    releasedHashReused: second.hash === first.hash,
    expiredFound: (await store.get(first.hash, "session-1")) !== null,
    retainedExpiredOriginal: [...hashHistory.values()].some((values) =>
      values.has(createContentDigest(contents.first)),
    ),
    historyEntryCount: [...hashHistory.values()].reduce(
      (sum, values) => sum + values.size,
      0,
    ),
  };
}

async function observeCapacityInvariant(): Promise<CapacityInvariantResult> {
  let now = 1_000;
  const store = new MemoryCCRStore(() => now, { maxEntries: 2 });
  const put = (id: string, ttlMs: number) =>
    store.put({
      sessionID: "session-1",
      callID: id,
      tool: "Bash",
      strategy: "text",
      originalContent: `original-${id}`,
      compressedContent: `compressed-${id}`,
      originalTokens: 4,
      compressedTokens: 2,
      ttlMs,
    });

  const oldest = await put("oldest", 100);
  now = 1_001;
  const expired = await put("expired", 1);
  now = 1_003;
  const middle = await put("middle", 100);
  const oldestSurvivedExpiredPrune =
    (await store.get(oldest.hash, "session-1")) !== null;
  const expiredFound =
    (await store.get(expired.hash, "session-1")) !== null;
  now = 1_004;
  const newest = await put("newest", 100);

  return {
    expiredFound,
    oldestSurvivedExpiredPrune,
    oldestFoundAfterOverflow:
      (await store.get(oldest.hash, "session-1")) !== null,
    middleFound: (await store.get(middle.hash, "session-1")) !== null,
    newestFound: (await store.get(newest.hash, "session-1")) !== null,
    entryCount: (await store.stats()).entryCount,
  };
}

async function observeDeleteSessionInvariant(): Promise<DeleteSessionInvariantResult> {
  const store = new MemoryCCRStore(
    undefined,
    {},
    undefined,
    forcedCollisionHashing(),
  );
  const contents = collisionContents();
  const put = (sessionID: string, callID: string, originalContent: string) =>
    store.put({
      sessionID,
      callID,
      tool: "Bash",
      strategy: "text",
      originalContent,
      compressedContent: `compressed-${callID}`,
      originalTokens: 4,
      compressedTokens: 2,
      ttlMs: 60_000,
    });

  const deletedOriginal = await put("session-1", "deleted", contents.first);
  const otherCollision = await put("session-2", "collision", contents.second);
  await put("session-1", "shared-1", "shared original");
  const sharedOtherSession = await put(
    "session-2",
    "shared-2",
    "shared original",
  );

  const removed = await store.deleteSession("session-1");
  const releasedHash = await put("session-3", "reallocated", contents.second);

  return {
    removed,
    deletedSessionEntries: (await store.stats("session-1")).entryCount,
    deletedOriginalFound:
      (await store.get(deletedOriginal.hash, "session-1")) !== null,
    otherCollisionFound:
      (await store.get(otherCollision.hash, "session-2")) !== null,
    sharedOtherSessionFound:
      (await store.get(sharedOtherSession.hash, "session-2")) !== null,
    releasedHashReused: releasedHash.hash === deletedOriginal.hash,
  };
}

async function observeCloseInvariant(): Promise<CloseInvariantResult> {
  const store = new MemoryCCRStore();
  let firstCloseSucceeded = false;
  let secondCloseSucceeded = false;
  await store.close();
  firstCloseSucceeded = true;
  await store.close();
  secondCloseSucceeded = true;
  return { firstCloseSucceeded, secondCloseSucceeded };
}

function observeSQLiteMarkerInvariant(): MarkerInvariantResult {
  const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-invariants-"));
  const path = join(dir, "ccr.sqlite");
  try {
    const output = execFileSync(
      "bun",
      [
        "--eval",
        `
import { NativeHeadroomCompatibleEngine } from "./src/engine/native.ts";
import {
  createCollisionHash,
  createContentDigest,
  createContentHash,
} from "./src/store/ccr.ts";
import { BunSQLiteCCRStore } from "./src/store/sqlite-bun.ts";

const { Database } = await import("bun:sqlite");

const suffix = Array.from(
  { length: 100 },
  (_, index) => \`repeat line \${index % 3}\`,
).join("\\n");
const firstOriginal = \`forced-collision-first\\n\${suffix}\`;
const secondOriginal = \`forced-collision-second\\n\${suffix}\`;
const hashing = {
  contentHash: (content) => content.startsWith("forced-collision-")
    ? "0".repeat(24)
    : createContentHash(content),
  contentDigest: createContentDigest,
  collisionHash: createCollisionHash,
};
const store = new BunSQLiteCCRStore(
  process.env.CCR_DB_PATH,
  Database,
  undefined,
  {},
  undefined,
  hashing,
);
const engine = new NativeHeadroomCompatibleEngine(store);
const first = await engine.compress({
  tool: "Bash",
  sessionID: "session-1",
  callID: "call-1",
  args: {},
  output: firstOriginal,
  ttlMs: 60_000,
});
const second = await engine.compress({
  tool: "Bash",
  sessionID: "session-1",
  callID: "call-2",
  args: {},
  output: secondOriginal,
  ttlMs: 60_000,
});
const retrieved = await engine.retrieve(second.hash, { mode: "full" });
console.log(JSON.stringify({
  firstHash: first.hash,
  secondHash: second.hash,
  secondOutput: second.output,
  secondOriginal,
  retrievedOriginal: retrieved.found ? retrieved.output : null,
}));
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, CCR_DB_PATH: path },
      },
    );
    return JSON.parse(output) as MarkerInvariantResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function observeSQLiteSessionInvariant(): SessionInvariantResult {
  const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-invariants-"));
  const path = join(dir, "ccr.sqlite");
  try {
    const output = execFileSync(
      "bun",
      [
        "--eval",
        `
import { NativeHeadroomCompatibleEngine } from "./src/engine/native.ts";
import { createBunSQLiteStore } from "./src/store/sqlite-bun.ts";

const store = await createBunSQLiteStore(process.env.CCR_DB_PATH);
const original = "private output for session-1";
const entry = await store.put({
  sessionID: "session-1",
  callID: "call-1",
  tool: "Bash",
  strategy: "text",
  originalContent: original,
  compressedContent: "compressed",
  originalTokens: 5,
  compressedTokens: 1,
  ttlMs: 60_000,
});
const engine = new NativeHeadroomCompatibleEngine(store);
const other = await engine.retrieve(entry.hash, { mode: "full" }, "session-2");
const owner = await engine.retrieve(entry.hash, { mode: "full" }, "session-1");
console.log(JSON.stringify({
  ownerFound: owner.found,
  ownerOutput: owner.output,
  otherFound: other.found,
  retrievals: (await store.stats("session-1")).totalRetrievals,
}));
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, CCR_DB_PATH: path },
      },
    );
    return JSON.parse(output) as SessionInvariantResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function observeSQLiteRetentionInvariant(): RetentionInvariantResult {
  const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-invariants-"));
  const path = join(dir, "ccr.sqlite");
  try {
    const output = execFileSync(
      "bun",
      [
        "--eval",
        `
import { readFileSync } from "node:fs";
import {
  createCollisionHash,
  createContentDigest,
  createContentHash,
} from "./src/store/ccr.ts";
import { BunSQLiteCCRStore } from "./src/store/sqlite-bun.ts";

const { Database } = await import("bun:sqlite");
let now = 1_000;
const suffix = Array.from(
  { length: 100 },
  (_, index) => \`repeat line \${index % 3}\`,
).join("\\n");
const firstOriginal = \`forced-collision-first\\n\${suffix}\`;
const secondOriginal = \`forced-collision-second\\n\${suffix}\`;
const hashing = {
  contentHash: (content) => content.startsWith("forced-collision-")
    ? "0".repeat(24)
    : createContentHash(content),
  contentDigest: createContentDigest,
  collisionHash: createCollisionHash,
};
const store = new BunSQLiteCCRStore(
  process.env.CCR_DB_PATH,
  Database,
  () => now,
  {},
  undefined,
  hashing,
);
const first = await store.put({
  sessionID: "session-1",
  callID: "call-1",
  tool: "Bash",
  strategy: "text",
  originalContent: firstOriginal,
  compressedContent: "first",
  originalTokens: 10,
  compressedTokens: 1,
  ttlMs: 1,
});
now = 1_002;
await store.pruneExpired();
const second = await store.put({
  sessionID: "session-2",
  callID: "call-2",
  tool: "Bash",
  strategy: "text",
  originalContent: secondOriginal,
  compressedContent: "second",
  originalTokens: 10,
  compressedTokens: 1,
  ttlMs: 60_000,
});
const databaseBytes = readFileSync(process.env.CCR_DB_PATH);
console.log(JSON.stringify({
  releasedHashReused: second.hash === first.hash,
  expiredFound: (await store.get(first.hash, "session-1")) !== null,
  retainedExpiredOriginal: databaseBytes.includes(
    Buffer.from(firstOriginal, "utf16le"),
  ),
  historyEntryCount: store.db
    .query("SELECT COUNT(*) AS count FROM ccr_hash_history")
    .get().count,
}));
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, CCR_DB_PATH: path },
      },
    );
    return JSON.parse(output) as RetentionInvariantResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function observeSQLiteCapacityInvariant(): CapacityInvariantResult {
  const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-invariants-"));
  const path = join(dir, "ccr.sqlite");
  try {
    const output = execFileSync(
      "bun",
      [
        "--eval",
        `
import { BunSQLiteCCRStore } from "./src/store/sqlite-bun.ts";

const { Database } = await import("bun:sqlite");
let now = 1_000;
const store = new BunSQLiteCCRStore(
  process.env.CCR_DB_PATH,
  Database,
  () => now,
  { maxEntries: 2 },
);
const put = (id, ttlMs) => store.put({
  sessionID: "session-1",
  callID: id,
  tool: "Bash",
  strategy: "text",
  originalContent: \`original-\${id}\`,
  compressedContent: \`compressed-\${id}\`,
  originalTokens: 4,
  compressedTokens: 2,
  ttlMs,
});

const oldest = await put("oldest", 100);
now = 1_001;
const expired = await put("expired", 1);
now = 1_003;
const middle = await put("middle", 100);
const oldestSurvivedExpiredPrune =
  (await store.get(oldest.hash, "session-1")) !== null;
const expiredFound =
  (await store.get(expired.hash, "session-1")) !== null;
now = 1_004;
const newest = await put("newest", 100);
console.log(JSON.stringify({
  expiredFound,
  oldestSurvivedExpiredPrune,
  oldestFoundAfterOverflow:
    (await store.get(oldest.hash, "session-1")) !== null,
  middleFound: (await store.get(middle.hash, "session-1")) !== null,
  newestFound: (await store.get(newest.hash, "session-1")) !== null,
  entryCount: (await store.stats()).entryCount,
}));
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, CCR_DB_PATH: path },
      },
    );
    return JSON.parse(output) as CapacityInvariantResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function observeSQLiteDeleteSessionInvariant(): DeleteSessionInvariantResult {
  const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-invariants-"));
  const path = join(dir, "ccr.sqlite");
  try {
    const output = execFileSync(
      "bun",
      [
        "--eval",
        `
import {
  createCollisionHash,
  createContentDigest,
  createContentHash,
} from "./src/store/ccr.ts";
import { BunSQLiteCCRStore } from "./src/store/sqlite-bun.ts";

const { Database } = await import("bun:sqlite");
const hashing = {
  contentHash: (content) => content.startsWith("forced-collision-")
    ? "0".repeat(24)
    : createContentHash(content),
  contentDigest: createContentDigest,
  collisionHash: createCollisionHash,
};
const store = new BunSQLiteCCRStore(
  process.env.CCR_DB_PATH,
  Database,
  undefined,
  {},
  undefined,
  hashing,
);
const firstContent = "forced-collision-first";
const secondContent = "forced-collision-second";
const put = (sessionID, callID, originalContent) => store.put({
  sessionID,
  callID,
  tool: "Bash",
  strategy: "text",
  originalContent,
  compressedContent: \`compressed-\${callID}\`,
  originalTokens: 4,
  compressedTokens: 2,
  ttlMs: 60_000,
});

const deletedOriginal = await put("session-1", "deleted", firstContent);
const otherCollision = await put("session-2", "collision", secondContent);
await put("session-1", "shared-1", "shared original");
const sharedOtherSession = await put(
  "session-2",
  "shared-2",
  "shared original",
);
const removed = await store.deleteSession("session-1");
const releasedHash = await put("session-3", "reallocated", secondContent);
console.log(JSON.stringify({
  removed,
  deletedSessionEntries: (await store.stats("session-1")).entryCount,
  deletedOriginalFound:
    (await store.get(deletedOriginal.hash, "session-1")) !== null,
  otherCollisionFound:
    (await store.get(otherCollision.hash, "session-2")) !== null,
  sharedOtherSessionFound:
    (await store.get(sharedOtherSession.hash, "session-2")) !== null,
  releasedHashReused: releasedHash.hash === deletedOriginal.hash,
}));
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, CCR_DB_PATH: path },
      },
    );
    return JSON.parse(output) as DeleteSessionInvariantResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function observeSQLiteCloseInvariant(): CloseInvariantResult {
  const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-invariants-"));
  const path = join(dir, "ccr.sqlite");
  try {
    const output = execFileSync(
      "bun",
      [
        "--eval",
        `
import { createBunSQLiteStore } from "./src/store/sqlite-bun.ts";

const store = await createBunSQLiteStore(process.env.CCR_DB_PATH);
let firstCloseSucceeded = false;
let secondCloseSucceeded = false;
await store.close();
firstCloseSucceeded = true;
await store.close();
secondCloseSucceeded = true;
console.log(JSON.stringify({ firstCloseSucceeded, secondCloseSucceeded }));
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, CCR_DB_PATH: path },
      },
    );
    return JSON.parse(output) as CloseInvariantResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const adapters = [
  {
    name: "memory",
    observe: () =>
      observeMarkerInvariant(
        new MemoryCCRStore(
          undefined,
          {},
          undefined,
          forcedCollisionHashing(),
        ),
      ),
    observeSession: () => observeSessionInvariant(new MemoryCCRStore()),
    observeRetention: () => observeRetentionInvariant(),
    observeCapacity: () => observeCapacityInvariant(),
    observeDeleteSession: () => observeDeleteSessionInvariant(),
    observeClose: () => observeCloseInvariant(),
  },
  {
    name: "bun-sqlite",
    observe: async () => observeSQLiteMarkerInvariant(),
    observeSession: async () => observeSQLiteSessionInvariant(),
    observeRetention: async () => observeSQLiteRetentionInvariant(),
    observeCapacity: async () => observeSQLiteCapacityInvariant(),
    observeDeleteSession: async () => observeSQLiteDeleteSessionInvariant(),
    observeClose: async () => observeSQLiteCloseInvariant(),
  },
];

describe.each(adapters)("$name CCR invariants", ({
  observe,
  observeSession,
  observeRetention,
  observeCapacity,
  observeDeleteSession,
  observeClose,
}) => {
  it("emits the committed Store key in every compressed marker", async () => {
    const result = await observe();

    expect(result.secondHash).not.toBe(result.firstHash);
    expect(result.secondOutput).toContain(
      formatRetrieveMarker(result.secondHash),
    );
    expect(result.secondOutput).not.toContain(
      formatRetrieveMarker(result.firstHash),
    );
    expect(result.retrievedOriginal).toBe(result.secondOriginal);
  });

  it("retrieves an entry only from its owning session", async () => {
    const result = await observeSession();

    expect(result.otherFound).toBe(false);
    expect(result.ownerFound).toBe(true);
    expect(result.ownerOutput).toBe("private output for session-1");
    expect(result.retrievals).toBe(1);
  });

  it("does not retain expired originals in collision history", async () => {
    const result = await observeRetention();

    expect(result.expiredFound).toBe(false);
    expect(result.releasedHashReused).toBe(true);
    expect(result.retainedExpiredOriginal).toBe(false);
    expect(result.historyEntryCount).toBe(1);
  });

  it("prunes expired entries before enforcing the capacity limit", async () => {
    const result = await observeCapacity();

    expect(result.expiredFound).toBe(false);
    expect(result.oldestSurvivedExpiredPrune).toBe(true);
    expect(result.oldestFoundAfterOverflow).toBe(false);
    expect(result.middleFound).toBe(true);
    expect(result.newestFound).toBe(true);
    expect(result.entryCount).toBe(2);
  });

  it("deletes a session and releases only unreferenced hash history", async () => {
    const result = await observeDeleteSession();

    expect(result.removed).toBe(2);
    expect(result.deletedSessionEntries).toBe(0);
    expect(result.deletedOriginalFound).toBe(false);
    expect(result.otherCollisionFound).toBe(true);
    expect(result.sharedOtherSessionFound).toBe(true);
    expect(result.releasedHashReused).toBe(true);
  });

  it("closes idempotently", async () => {
    const result = await observeClose();

    expect(result.firstCloseSucceeded).toBe(true);
    expect(result.secondCloseSucceeded).toBe(true);
  });
});

describe("bun-sqlite startup invariants", () => {
  it("prunes expired rows and records the schema version on startup", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-startup-"));
    const path = join(dir, "ccr.sqlite");
    try {
      const output = execFileSync(
        "bun",
        [
          "--eval",
          `
import { BunSQLiteCCRStore } from "./src/store/sqlite-bun.ts";

const { Database } = await import("bun:sqlite");
let now = 1_000;
const first = new BunSQLiteCCRStore(
  process.env.CCR_DB_PATH,
  Database,
  () => now,
);
const put = (id, ttlMs) => first.put({
  sessionID: "session-1",
  callID: id,
  tool: "Bash",
  strategy: "text",
  originalContent: \`original-\${id}\`,
  compressedContent: \`compressed-\${id}\`,
  originalTokens: 4,
  compressedTokens: 2,
  ttlMs,
});
await put("expired", 1);
await put("active", 100);
await first.close();

now = 1_002;
const reopened = new BunSQLiteCCRStore(
  process.env.CCR_DB_PATH,
  Database,
  () => now,
);
const inspector = new Database(process.env.CCR_DB_PATH, { readonly: true });
const expiredRows = inspector
  .query("SELECT COUNT(*) AS count FROM ccr_entries WHERE expires_at <= ?")
  .get(now).count;
const activeRows = inspector
  .query("SELECT COUNT(*) AS count FROM ccr_entries")
  .get().count;
const userVersion = inspector.query("PRAGMA user_version").get().user_version;
inspector.close();
await reopened.close();
console.log(JSON.stringify({ expiredRows, activeRows, userVersion }));
`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, CCR_DB_PATH: path },
        },
      );
      const result = JSON.parse(output) as {
        expiredRows: number;
        activeRows: number;
        userVersion: number;
      };

      expect(result.expiredRows).toBe(0);
      expect(result.activeRows).toBe(1);
      expect(result.userVersion).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a newer schema version without downgrading it", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-startup-"));
    const path = join(dir, "ccr.sqlite");
    try {
      const output = execFileSync(
        "bun",
        [
          "--eval",
          `
import { BunSQLiteCCRStore } from "./src/store/sqlite-bun.ts";

const { Database } = await import("bun:sqlite");
const seed = new Database(process.env.CCR_DB_PATH);
seed.exec("PRAGMA user_version = 999");
seed.close();
let message = "";
try {
  const store = new BunSQLiteCCRStore(process.env.CCR_DB_PATH, Database);
  await store.close();
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
const inspector = new Database(process.env.CCR_DB_PATH, { readonly: true });
const userVersion = inspector.query("PRAGMA user_version").get().user_version;
inspector.close();
console.log(JSON.stringify({ message, userVersion }));
`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, CCR_DB_PATH: path },
        },
      );
      const result = JSON.parse(output) as {
        message: string;
        userVersion: number;
      };

      expect(result.message).toContain("newer schema version 999");
      expect(result.userVersion).toBe(999);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("configures the requested busy timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-startup-"));
    const path = join(dir, "ccr.sqlite");
    try {
      const output = execFileSync(
        "bun",
        [
          "--eval",
          `
import { BunSQLiteCCRStore } from "./src/store/sqlite-bun.ts";

const { Database } = await import("bun:sqlite");
const store = new BunSQLiteCCRStore(
  process.env.CCR_DB_PATH,
  Database,
  undefined,
  { busyTimeoutMs: 1_234 },
);
const timeout = store["db"].query("PRAGMA busy_timeout").get().timeout;
await store.close();
console.log(JSON.stringify({ timeout }));
`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, CCR_DB_PATH: path },
        },
      );
      const result = JSON.parse(output) as { timeout: number };

      expect(result.timeout).toBe(1_234);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writes from multiple processes", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-concurrency-"));
    const path = join(dir, "ccr.sqlite");
    try {
      const output = execFileSync(
        "bun",
        [
          "--eval",
          `
import { BunSQLiteCCRStore } from "./src/store/sqlite-bun.ts";

const { Database } = await import("bun:sqlite");
const initializer = new BunSQLiteCCRStore(
  process.env.CCR_DB_PATH,
  Database,
);
await initializer.close();
const worker = \`
  import { createBunSQLiteStore } from "./src/store/sqlite-bun.ts";
  const store = await createBunSQLiteStore(process.env.CCR_DB_PATH);
  const workerID = process.env.WORKER_ID;
  for (let index = 0; index < 20; index += 1) {
    await store.put({
      sessionID: \\\`session-\\\${workerID}\\\`,
      callID: \\\`call-\\\${index}\\\`,
      tool: "Bash",
      strategy: "text",
      originalContent: \\\`original-\\\${workerID}-\\\${index}\\\`,
      compressedContent: \\\`compressed-\\\${workerID}-\\\${index}\\\`,
      originalTokens: 4,
      compressedTokens: 2,
      ttlMs: 60_000,
    });
  }
  await store.close();
\`;
const children = Array.from({ length: 4 }, (_, workerID) =>
  Bun.spawn(["bun", "--eval", worker], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CCR_DB_PATH: process.env.CCR_DB_PATH,
      WORKER_ID: String(workerID),
    },
    stdout: "pipe",
    stderr: "pipe",
  }),
);
const results = await Promise.all(
  children.map(async (child) => ({
    code: await child.exited,
    stderr: await new Response(child.stderr).text(),
  })),
);
const inspector = new Database(process.env.CCR_DB_PATH, { readonly: true });
const entryCount = inspector
  .query("SELECT COUNT(*) AS count FROM ccr_entries")
  .get().count;
inspector.close();
console.log(JSON.stringify({ results, entryCount }));
`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, CCR_DB_PATH: path },
        },
      );
      const result = JSON.parse(output) as {
        results: Array<{ code: number; stderr: string }>;
        entryCount: number;
      };

      expect(result.results.map((worker) => worker.code)).toEqual([0, 0, 0, 0]);
      expect(result.results.map((worker) => worker.stderr)).toEqual([
        "",
        "",
        "",
        "",
      ]);
      expect(result.entryCount).toBe(80);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
