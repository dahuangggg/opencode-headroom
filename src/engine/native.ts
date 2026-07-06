import { containsCCRMarker } from "../markers.js";
import { createContentHash } from "../store/ccr.js";
import type { CCRStore } from "../store/types.js";
import { estimateTokens } from "../token.js";
import { compressByContentType } from "./router.js";
import type {
  CompressionEngine,
  RetrieveResult,
  StatsResult,
  ToolOutputCompressionInput,
  ToolOutputCompressionResult,
} from "./types.js";

function queryFromArgs(args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  return Object.values(args as Record<string, unknown>)
    .filter((value) => ["string", "number", "boolean"].includes(typeof value))
    .join(" ")
    .slice(0, 300);
}

export class NativeHeadroomCompatibleEngine implements CompressionEngine {
  name = "native";

  constructor(private store: CCRStore) {}

  async compress(
    input: ToolOutputCompressionInput,
  ): Promise<ToolOutputCompressionResult> {
    const originalTokens = estimateTokens(input.output);
    if (!input.output.trim() || containsCCRMarker(input.output)) {
      return {
        changed: false,
        output: input.output,
        strategy: "passthrough",
        originalTokens,
        compressedTokens: originalTokens,
        reason: "empty_or_marked",
        debug: {
          ccr: { stored: false },
        },
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
        debug: {
          ...(compressed.debug ?? {}),
          ccr: { stored: false },
        },
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
      debug: {
        ...(compressed.debug ?? {}),
        ccr: { hash: entry.hash, stored: true },
      },
    };
  }

  async retrieve(hash: string): Promise<RetrieveResult> {
    const entry = await this.store.get(hash);
    if (!entry) {
      return {
        found: false,
        output:
          "Entry not found or expired. Re-run the command or re-read the file to recover the original output.",
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
