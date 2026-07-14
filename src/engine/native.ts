import { containsCCRMarker } from "../markers.js";
import { compressionProfileForStrength } from "../compressors/profile.js";
import { createContentHash } from "../store/ccr.js";
import type { CCRStore } from "../store/types.js";
import { estimateTokens } from "../token.js";
import { retrieveEntry } from "./retrieve.js";
import { compressByContentType } from "./router.js";
import type {
  CompressionEngine,
  RetrieveRequest,
  RetrieveResult,
  StatsResult,
  ToolOutputCompressionInput,
  ToolOutputCompressionResult,
} from "./types.js";

export function buildCompressionQuery(args: unknown, intent?: string): string {
  const scalarArgs =
    args && typeof args === "object"
      ? Object.values(args as Record<string, unknown>)
          .filter((value) =>
            ["string", "number", "boolean"].includes(typeof value),
          )
          .join(" ")
      : "";
  return [intent?.trim(), scalarArgs]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, 2_000);
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
    const profile = compressionProfileForStrength(input.strength);
    const compressed = compressByContentType({
      content: input.output,
      hash,
      query: buildCompressionQuery(input.args, input.intent),
      profile,
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
      retrieveDefaults: input.retrieveDefaults,
      contentForHash: (committedHash) => {
        if (committedHash === hash) {
          return {
            compressedContent: compressed.output,
            compressedTokens,
          };
        }

        const finalized = compressByContentType({
          content: input.output,
          hash: committedHash,
          query: buildCompressionQuery(input.args, input.intent),
          profile,
        });
        return {
          compressedContent: finalized.output,
          compressedTokens: estimateTokens(finalized.output),
        };
      },
    });

    return {
      changed: true,
      output: entry.compressedContent,
      strategy: compressed.strategy,
      hash: entry.hash,
      originalTokens,
      compressedTokens: entry.compressedTokens,
      debug: {
        ...(compressed.debug ?? {}),
        ccr: { hash: entry.hash, stored: true },
      },
    };
  }

  async retrieve(
    hash: string,
    request?: RetrieveRequest,
    sessionID?: string,
  ): Promise<RetrieveResult> {
    const entry = await this.store.get(hash, sessionID);
    if (!entry) {
      return {
        found: false,
        output:
          "Entry not found or expired. Re-run the command or re-read the file to recover the original output.",
      };
    }
    return { found: true, output: retrieveEntry(entry, request) };
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
