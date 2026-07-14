import {
  DEFAULT_CCR_HASH_PROVIDER,
  type CCRHashProvider,
} from "./ccr.js";
import {
  resolveCCRMaxEntries,
  type CCREntry,
  type CCRPutInput,
  type CCRStats,
  type CCRStore,
  type CCRStoreDiagnostics,
  type CCRStoreOptions,
} from "./types.js";

export class MemoryCCRStore implements CCRStore {
  readonly diagnostics: CCRStoreDiagnostics;
  private entries = new Map<string, CCREntry[]>();
  private hashHistory = new Map<string, Set<string>>();
  private insertionOrder: CCREntry[] = [];
  private maxEntries: number;

  constructor(
    private now: () => number = () => Date.now(),
    options: CCRStoreOptions = {},
    diagnostics: CCRStoreDiagnostics = {
      requested: "memory",
      active: "memory",
    },
    private hashing: CCRHashProvider = DEFAULT_CCR_HASH_PROVIDER,
  ) {
    this.maxEntries = resolveCCRMaxEntries(options.maxEntries);
    this.diagnostics = { ...diagnostics };
  }

  setNowForTest(now: () => number): void {
    this.now = now;
  }

  private allocateHash(originalContent: string): string {
    const contentDigest = this.hashing.contentDigest(originalContent);
    const baseHash = this.hashing.contentHash(originalContent);
    const baseHistory = this.hashHistory.get(baseHash);
    if (!baseHistory || baseHistory.has(contentDigest)) {
      return baseHash;
    }

    for (let attempt = 1; ; attempt += 1) {
      const candidate = this.hashing.collisionHash(originalContent, attempt);
      const candidateHistory = this.hashHistory.get(candidate);
      if (!candidateHistory || candidateHistory.has(contentDigest)) {
        return candidate;
      }
    }
  }

  private recordHashHistory(hash: string, originalContent: string): void {
    const history = this.hashHistory.get(hash) ?? new Set<string>();
    history.add(this.hashing.contentDigest(originalContent));
    this.hashHistory.set(hash, history);
  }

  private evictOldest(count: number): void {
    for (let removed = 0; removed < count; removed += 1) {
      const oldest = this.insertionOrder.shift();
      if (!oldest) {
        break;
      }
      const entries = this.entries.get(oldest.hash);
      if (!entries) {
        continue;
      }
      const remaining = entries.filter((entry) => entry !== oldest);
      if (remaining.length === 0) {
        this.entries.delete(oldest.hash);
        this.hashHistory.delete(oldest.hash);
      } else {
        this.entries.set(oldest.hash, remaining);
      }
    }
  }

  private pruneExpiredEntries(now: number): number {
    let removed = 0;

    for (const [hash, entries] of this.entries) {
      const activeEntries = entries.filter((entry) => entry.expiresAt > now);
      removed += entries.length - activeEntries.length;
      if (activeEntries.length === 0) {
        this.entries.delete(hash);
        this.hashHistory.delete(hash);
      } else if (activeEntries.length !== entries.length) {
        this.entries.set(hash, activeEntries);
      }
    }
    if (removed > 0) {
      this.insertionOrder = this.insertionOrder.filter(
        (entry) => entry.expiresAt > now,
      );
    }

    return removed;
  }

  async put(input: CCRPutInput): Promise<CCREntry> {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("CCR ttlMs must be a positive finite number");
    }

    const createdAt = this.now();
    this.pruneExpiredEntries(createdAt);
    const entriesToEvict = Math.max(
      0,
      this.insertionOrder.length - this.maxEntries + 1,
    );
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

    // Finalize marker-bearing content before the only destructive capacity
    // mutation, so a rendering failure leaves every live entry untouched.
    this.evictOldest(entriesToEvict);
    const entries = this.entries.get(hash) ?? [];
    entries.push(entry);
    this.entries.set(hash, entries);
    this.insertionOrder.push(entry);
    this.recordHashHistory(hash, input.originalContent);

    return { ...entry };
  }

  private findEntry(
    hash: string,
    sessionID: string | undefined,
    countRetrieval: boolean,
  ): CCREntry | null {
    const entries = this.entries.get(hash);
    if (!entries) {
      return null;
    }

    const now = this.now();
    const activeEntries = entries.filter((entry) => entry.expiresAt > now);
    if (activeEntries.length === 0) {
      this.entries.delete(hash);
      this.insertionOrder = this.insertionOrder.filter(
        (entry) => entry.hash !== hash,
      );
      this.hashHistory.delete(hash);
      return null;
    }

    if (activeEntries.length !== entries.length) {
      this.entries.set(hash, activeEntries);
      const active = new Set(activeEntries);
      this.insertionOrder = this.insertionOrder.filter(
        (entry) => entry.hash !== hash || active.has(entry),
      );
    }

    const entry = [...activeEntries].reverse().find(
      (candidate) =>
        sessionID === undefined || candidate.sessionID === sessionID,
    );
    if (!entry) {
      return null;
    }
    if (countRetrieval) entry.retrievalCount += 1;

    return { ...entry };
  }

  async peek(hash: string, sessionID?: string): Promise<CCREntry | null> {
    return this.findEntry(hash, sessionID, false);
  }

  async get(hash: string, sessionID?: string): Promise<CCREntry | null> {
    return this.findEntry(hash, sessionID, true);
  }

  async deleteSession(sessionID: string): Promise<number> {
    this.pruneExpiredEntries(this.now());
    let removed = 0;
    for (const [hash, entries] of this.entries) {
      const remaining = entries.filter((entry) => {
        if (entry.sessionID !== sessionID) {
          return true;
        }
        removed += 1;
        return false;
      });
      if (remaining.length === 0) {
        this.entries.delete(hash);
        this.hashHistory.delete(hash);
      } else if (remaining.length !== entries.length) {
        this.entries.set(hash, remaining);
      }
    }
    if (removed > 0) {
      this.insertionOrder = this.insertionOrder.filter(
        (entry) => entry.sessionID !== sessionID,
      );
    }
    return removed;
  }

  async close(): Promise<void> {
    // Memory storage owns no external resources.
  }

  async stats(sessionID?: string): Promise<CCRStats> {
    await this.pruneExpired();

    const entries = [...this.entries.values()].flat().filter(
      (entry) => sessionID === undefined || entry.sessionID === sessionID,
    );

    return {
      entryCount: entries.length,
      totalOriginalTokens: entries.reduce(
        (sum, entry) => sum + entry.originalTokens,
        0,
      ),
      totalCompressedTokens: entries.reduce(
        (sum, entry) => sum + entry.compressedTokens,
        0,
      ),
      totalTokensSaved: entries.reduce(
        (sum, entry) =>
          sum + Math.max(0, entry.originalTokens - entry.compressedTokens),
        0,
      ),
      totalRetrievals: entries.reduce(
        (sum, entry) => sum + entry.retrievalCount,
        0,
      ),
    };
  }

  async pruneExpired(now: number = this.now()): Promise<number> {
    return this.pruneExpiredEntries(now);
  }
}
