import { containsCCRMarker } from "../markers.js";
import {
  compressionProfileForStrength,
  type CompressionProfile,
} from "../compressors/profile.js";
import type { CompressorResult } from "../compressors/types.js";
import { createContentHash } from "../store/ccr.js";
import type { CCRStore } from "../store/types.js";
import {
  SessionRepetitionStore,
  type RepetitionMatch,
} from "../session/repetition.js";
import { estimateTokens } from "../token.js";
import {
  CompressionDecisionCache,
  createCompressionDecisionKey,
  StrategyCircuitBreaker,
  type CompressionDecisionCacheStats,
  type CachedCompressionResult,
} from "./resilience.js";
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

export interface NativeHeadroomEngineOptions {
  losslessThenLossy?: boolean;
}

export interface NativeHeadroomEngineInternals {
  decisionCache?: CompressionDecisionCache;
  compressor?: typeof compressByContentType;
  circuitBreaker?: StrategyCircuitBreaker;
}

const MAX_COMPRESSION_QUERY_CHARS = 2_000;
const MAX_COMPRESSION_ARG_CHARS = 300;
const DEFAULT_DECISION_CACHE_MAX_ENTRIES = 512;
const DEFAULT_DECISION_CACHE_MAX_RESULT_CHARS = 2_000_000;
const DEFAULT_DECISION_CACHE_MAX_SINGLE_RESULT_CHARS = 250_000;

function joinBoundedScalars(values: readonly string[], maxChars: number): string {
  if (values.length === 0 || maxChars <= 0) {
    return "";
  }

  let remaining = Math.max(0, maxChars - (values.length - 1));
  const pieces = values.map((value, index) => {
    const remainingValues = values.length - index;
    const share = Math.floor(remaining / remainingValues);
    const piece = value.slice(0, share);
    remaining -= piece.length;
    return piece;
  });
  return pieces.join(" ").slice(0, maxChars);
}

export function buildCompressionQuery(args: unknown, intent?: string): string {
  const scalarArgs =
    args && typeof args === "object"
      ? joinBoundedScalars(
          Object.values(args as Record<string, unknown>)
            .filter((value) =>
              ["string", "number", "boolean"].includes(typeof value),
            )
            .map(String)
            .filter(Boolean),
          MAX_COMPRESSION_ARG_CHARS,
        )
      : "";
  const separatorChars = scalarArgs ? 1 : 0;
  const intentBudget =
    MAX_COMPRESSION_QUERY_CHARS - scalarArgs.length - separatorChars;
  const boundedIntent = intent?.trim().slice(0, intentBudget);
  return [boundedIntent, scalarArgs]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function repetitionSummary(hash: string, match: RepetitionMatch): string {
  const relationship =
    match.kind === "exact"
      ? "exact match to an earlier result"
      : `${Math.round(match.similarity * 100)}% similar to an earlier result`;
  return [
    `[Repeated tool output: ${relationship} in this session]`,
    `[Retrieve more: hash=${hash}]`,
  ].join("\n");
}

export class NativeHeadroomCompatibleEngine implements CompressionEngine {
  name = "native";
  private readonly decisionCache: CompressionDecisionCache;
  private readonly compressor: typeof compressByContentType;
  private readonly circuitBreaker: StrategyCircuitBreaker;

  constructor(
    private store: CCRStore,
    private options: NativeHeadroomEngineOptions = {},
    private repetition = new SessionRepetitionStore(),
    internals: NativeHeadroomEngineInternals = {},
  ) {
    this.decisionCache =
      internals.decisionCache ??
      new CompressionDecisionCache({
        maxEntries: DEFAULT_DECISION_CACHE_MAX_ENTRIES,
        maxResultChars: DEFAULT_DECISION_CACHE_MAX_RESULT_CHARS,
        maxSingleResultChars: DEFAULT_DECISION_CACHE_MAX_SINGLE_RESULT_CHARS,
      });
    this.compressor = internals.compressor ?? compressByContentType;
    this.circuitBreaker =
      internals.circuitBreaker ?? new StrategyCircuitBreaker();
  }

  get repetitionSessionCount(): number {
    return this.repetition.sessionCount;
  }

  get decisionCacheStats(): Readonly<CompressionDecisionCacheStats> {
    return this.decisionCache.stats;
  }

  deleteSessionState(sessionID: string): void {
    this.repetition.delete(sessionID);
  }

  clearSessionState(): void {
    this.repetition.clear();
    this.decisionCache.clear();
    this.circuitBreaker.clear();
  }

  async compress(
    input: ToolOutputCompressionInput,
  ): Promise<ToolOutputCompressionResult> {
    return this.compressInternal(input);
  }

  async compressWithKnownTokens(
    input: ToolOutputCompressionInput,
    originalTokens: number,
  ): Promise<ToolOutputCompressionResult> {
    if (!Number.isSafeInteger(originalTokens) || originalTokens < 0) {
      throw new Error("known original token count must be a non-negative safe integer");
    }
    return this.compressInternal(input, originalTokens);
  }

  private async compressInternal(
    input: ToolOutputCompressionInput,
    knownOriginalTokens?: number,
  ): Promise<ToolOutputCompressionResult> {
    if (!input.output.trim() || containsCCRMarker(input.output)) {
      const originalTokens =
        knownOriginalTokens ?? estimateTokens(input.output);
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
    const repetition = this.repetition.match(
      input.sessionID,
      input.output,
      Date.now(),
      hash,
    );
    if (repetition) {
      const originalTokens =
        knownOriginalTokens ?? estimateTokens(input.output);
      const candidate = repetitionSummary(hash, repetition);
      const candidateTokens = estimateTokens(candidate);
      if (candidateTokens < originalTokens) {
        const entry = await this.store.put({
          sessionID: input.sessionID,
          callID: input.callID,
          tool: input.tool,
          strategy: "repetition",
          originalContent: input.output,
          compressedContent: candidate,
          originalTokens,
          compressedTokens: candidateTokens,
          ttlMs: input.ttlMs,
          retrieveDefaults: input.retrieveDefaults,
          contentForHash: (committedHash) => {
            const output = repetitionSummary(committedHash, repetition);
            return {
              compressedContent: output,
              compressedTokens: estimateTokens(output),
            };
          },
        });
        this.repetition.record(
          input.sessionID,
          entry.hash,
          input.output,
          entry.expiresAt,
          hash,
        );
        return {
          changed: true,
          output: entry.compressedContent,
          strategy: "repetition",
          hash: entry.hash,
          originalTokens,
          compressedTokens: entry.compressedTokens,
          debug: {
            ccr: { hash: entry.hash, stored: true },
          },
        };
      }
    }

    const profile = compressionProfileForStrength(input.strength);
    const query = buildCompressionQuery(input.args, input.intent);
    const decisionKey = createCompressionDecisionKey({
      content: input.output,
      query,
      strength: input.strength,
      profile,
      losslessThenLossy: this.options.losslessThenLossy,
      knownOriginalTokens,
    });
    const cached = this.decisionCache.get(decisionKey);
    if (cached?.kind === "skip") {
      return {
        changed: false,
        output: input.output,
        strategy: cached.strategy,
        originalTokens: cached.originalTokens,
        compressedTokens: cached.originalTokens,
        reason: cached.reason,
        debug: {
          ccr: { stored: false },
        },
      };
    }
    if (cached?.kind === "result") {
      return this.commitCachedResult({
        input,
        hash,
        query,
        profile,
        knownOriginalTokens,
        decisionKey,
        cached,
      });
    }

    const compressed = this.runCompressor({
      content: input.output,
      hash,
      query,
      profile,
      originalTokens: knownOriginalTokens,
    });
    const originalTokens =
      knownOriginalTokens ??
      compressed.tokenCounts?.original ??
      estimateTokens(input.output);
    const compressedTokens = compressed.changed
      ? (compressed.tokenCounts?.compressed ?? estimateTokens(compressed.output))
      : originalTokens;
    const cacheable =
      compressed.cacheable !== false &&
      compressed.reason !== "strategy_circuit_open";
    if (!compressed.changed || compressedTokens >= originalTokens) {
      const reason = compressed.reason ?? "no_savings";
      if (cacheable) {
        this.decisionCache.putSkip(decisionKey, {
          strategy: compressed.strategy,
          reason,
          originalTokens,
        });
      }
      return {
        changed: false,
        output: input.output,
        strategy: compressed.strategy,
        originalTokens,
        compressedTokens: originalTokens,
        reason,
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

        return this.rerenderForHash({
          input,
          hash: committedHash,
          query,
          profile,
          knownOriginalTokens,
          originalTokens,
        });
      },
    });
    this.repetition.record(
      input.sessionID,
      entry.hash,
      input.output,
      entry.expiresAt,
      hash,
    );
    if (cacheable) {
      this.decisionCache.putResult(decisionKey, {
        output: entry.compressedContent,
        renderedHash: entry.hash,
        strategy: compressed.strategy,
        originalTokens,
        compressedTokens: entry.compressedTokens,
      });
    }

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

  private runCompressor(
    input: Parameters<typeof compressByContentType>[0],
  ): CompressorResult {
    return this.compressor(input, this.options, {
      circuitBreaker: this.circuitBreaker,
    });
  }

  private rerenderForHash(input: {
    input: ToolOutputCompressionInput;
    hash: string;
    query: string;
    profile: CompressionProfile;
    knownOriginalTokens?: number;
    originalTokens: number;
  }): { compressedContent: string; compressedTokens: number } {
    const finalized = this.runCompressor({
      content: input.input.output,
      hash: input.hash,
      query: input.query,
      profile: input.profile,
      originalTokens: input.knownOriginalTokens,
    });
    if (
      finalized.cacheable === false ||
      finalized.reason === "strategy_circuit_open"
    ) {
      throw new Error("cached compression rerender reached transient runtime state");
    }
    const compressedTokens = finalized.changed
      ? (finalized.tokenCounts?.compressed ?? estimateTokens(finalized.output))
      : input.originalTokens;
    if (!finalized.changed || compressedTokens >= input.originalTokens) {
      throw new Error(
        `cached compression could not be rendered for committed hash: ${finalized.reason ?? "no_savings"}`,
      );
    }
    return {
      compressedContent: finalized.output,
      compressedTokens,
    };
  }

  private async commitCachedResult(input: {
    input: ToolOutputCompressionInput;
    hash: string;
    query: string;
    profile: CompressionProfile;
    knownOriginalTokens?: number;
    decisionKey: string;
    cached: CachedCompressionResult;
  }): Promise<ToolOutputCompressionResult> {
    const entry = await this.store.put({
      sessionID: input.input.sessionID,
      callID: input.input.callID,
      tool: input.input.tool,
      strategy: input.cached.strategy,
      originalContent: input.input.output,
      compressedContent: input.cached.output,
      originalTokens: input.cached.originalTokens,
      compressedTokens: input.cached.compressedTokens,
      ttlMs: input.input.ttlMs,
      retrieveDefaults: input.input.retrieveDefaults,
      contentForHash: (committedHash) => {
        if (committedHash === input.cached.renderedHash) {
          return {
            compressedContent: input.cached.output,
            compressedTokens: input.cached.compressedTokens,
          };
        }
        return this.rerenderForHash({
          input: input.input,
          hash: committedHash,
          query: input.query,
          profile: input.profile,
          knownOriginalTokens: input.knownOriginalTokens,
          originalTokens: input.cached.originalTokens,
        });
      },
    });
    this.repetition.record(
      input.input.sessionID,
      entry.hash,
      input.input.output,
      entry.expiresAt,
      input.hash,
    );
    this.decisionCache.putResult(input.decisionKey, {
      output: entry.compressedContent,
      renderedHash: entry.hash,
      strategy: input.cached.strategy,
      originalTokens: input.cached.originalTokens,
      compressedTokens: entry.compressedTokens,
    });

    return {
      changed: true,
      output: entry.compressedContent,
      strategy: input.cached.strategy,
      hash: entry.hash,
      originalTokens: input.cached.originalTokens,
      compressedTokens: entry.compressedTokens,
      debug: {
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
