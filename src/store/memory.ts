import { createCollisionHash, createContentHash } from "./ccr.js";
import type { CCREntry, CCRPutInput, CCRStats, CCRStore } from "./types.js";

export class MemoryCCRStore implements CCRStore {
  private entries = new Map<string, CCREntry[]>();

  constructor(private now: () => number = () => Date.now()) {}

  setNowForTest(now: () => number): void {
    this.now = now;
  }

  private allocateHash(originalContent: string): string {
    const baseHash = createContentHash(originalContent);
    const baseEntries = this.entries.get(baseHash);
    if (
      !baseEntries ||
      baseEntries.every((entry) => entry.originalContent === originalContent)
    ) {
      return baseHash;
    }

    for (let attempt = 1; ; attempt += 1) {
      const candidate = createCollisionHash(originalContent, attempt);
      const candidateEntries = this.entries.get(candidate);
      if (
        !candidateEntries ||
        candidateEntries.every(
          (entry) => entry.originalContent === originalContent,
        )
      ) {
        return candidate;
      }
    }
  }

  async put(input: CCRPutInput): Promise<CCREntry> {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("CCR ttlMs must be a positive finite number");
    }

    const createdAt = this.now();
    const hash = this.allocateHash(input.originalContent);
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

    const entries = this.entries.get(hash) ?? [];
    entries.push(entry);
    this.entries.set(hash, entries);

    return { ...entry };
  }

  async get(hash: string): Promise<CCREntry | null> {
    const entries = this.entries.get(hash);
    if (!entries) {
      return null;
    }

    const now = this.now();
    const activeEntries = entries.filter((entry) => entry.expiresAt > now);
    if (activeEntries.length === 0) {
      this.entries.delete(hash);
      return null;
    }

    if (activeEntries.length !== entries.length) {
      this.entries.set(hash, activeEntries);
    }

    const entry = activeEntries[activeEntries.length - 1];
    if (!entry) {
      return null;
    }
    entry.retrievalCount += 1;

    return { ...entry };
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
    let removed = 0;

    for (const [hash, entries] of this.entries) {
      const activeEntries = entries.filter((entry) => entry.expiresAt > now);
      removed += entries.length - activeEntries.length;
      if (activeEntries.length === 0) {
        this.entries.delete(hash);
      } else if (activeEntries.length !== entries.length) {
        this.entries.set(hash, activeEntries);
      }
    }

    return removed;
  }
}
