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
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(hash);
      return null;
    }

    entry.retrievalCount += 1;

    return { ...entry };
  }

  async stats(sessionID?: string): Promise<CCRStats> {
    await this.pruneExpired();

    const entries = [...this.entries.values()].filter(
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

    for (const [hash, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(hash);
        removed += 1;
      }
    }

    return removed;
  }
}
