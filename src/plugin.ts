import { isAbsolute, resolve } from "node:path";

import type { Plugin } from "@opencode-ai/plugin";

import {
  normalizeConfig,
  type HeadroomStorageConfig,
  type HeadroomPluginOptions,
} from "./config.js";
import {
  appendDebugRecord,
  debugRecordForLevel,
  shouldWriteDebugFile,
  shouldWriteDebugMetadata,
  type DebugDecision,
  type DebugTraceRecord,
} from "./debug.js";
import { NativeHeadroomCompatibleEngine } from "./engine/native.js";
import { containsCCRMarker } from "./markers.js";
import { resolveToolPolicy, type ResolvedToolPolicy } from "./policy.js";
import { SessionIntentStore } from "./session/intent.js";
import {
  createTrustedOutputFileSource,
  type TrustedOutputFileReadResult,
} from "./source/output-file.js";
import { createCCRStore } from "./store/ccr.js";
import {
  LocalTelemetryAggregator,
  type CompressionTelemetryReason,
} from "./telemetry.js";
import { estimateTokens } from "./token.js";
import { createRetrieveTool } from "./tools/retrieve.js";
import { createStatsTool } from "./tools/stats.js";

export type { HeadroomPluginOptions } from "./config.js";

type CompressionSourceKind = "toolOutput" | "outputPath";

interface CompressionSource {
  kind: CompressionSourceKind;
  content: string;
  displayContent: string;
  path?: string;
  readError?: string;
  tooLarge?: boolean;
}

const COMPRESSION_TELEMETRY_REASONS = new Set<CompressionTelemetryReason>([
  "compressed",
  "below_threshold",
  "legacy_skip_tool",
  "builtin_preserve",
  "default_preserve",
  "user_preserve",
  "too_large",
  "empty_or_marked",
  "code_passthrough",
  "diff_passthrough",
  "too_few_lines",
  "too_few_segments",
  "too_few_matches",
  "invalid_json",
  "not_large_array",
  "nothing_dropped",
  "no_savings",
  "mixed_no_savings",
  "mixed_passthrough",
  "candidate_empty_candidate",
  "candidate_invalid_structure",
  "candidate_protected_fact_lost",
  "candidate_no_token_savings",
  "source_denied",
  "hook_error",
]);

function telemetryReason(reason: string | undefined): CompressionTelemetryReason {
  return reason && COMPRESSION_TELEMETRY_REASONS.has(
    reason as CompressionTelemetryReason,
  )
    ? (reason as CompressionTelemetryReason)
    : "unknown";
}

function pluginBasePath(input: {
  directory?: string;
  worktree?: string;
}): string {
  if (input.worktree && input.worktree !== "/") {
    return input.worktree;
  }
  if (input.directory) {
    return input.directory;
  }
  return process.cwd();
}

function resolveStorageConfig(
  storage: HeadroomStorageConfig,
  basePath: string,
): HeadroomStorageConfig {
  return {
    ...storage,
    path: isAbsolute(storage.path) ? storage.path : resolve(basePath, storage.path),
  };
}

function metadataRecord(metadata: unknown): Record<string, unknown> | undefined {
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : undefined;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataOutputPath(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  return (
    metadataString(metadata, "outputPath") ??
    metadataString(metadata, "outputFile") ??
    metadataString(metadata, "outputRef")
  );
}

function looksLikeTruncatedOutput(
  displayOutput: string,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const metadataOutput = metadataString(metadata, "output") ?? "";
  return (
    metadata?.truncated === true ||
    displayOutput.trimStart().startsWith("...output truncated") ||
    metadataOutput.trimStart().startsWith("...output truncated")
  );
}

function sourceDebug(source: CompressionSource): DebugTraceRecord["source"] {
  return {
    kind: source.kind,
    ...(source.path ? { path: source.path } : {}),
    displayChars: source.displayContent.length,
    originalChars: source.content.length,
    ...(source.readError ? { readError: source.readError } : {}),
  };
}

function outputPathSourceMetadata(
  source: CompressionSource,
): Record<string, unknown> | undefined {
  if (source.kind !== "outputPath") {
    return undefined;
  }

  return {
    kind: "outputPath",
    path: source.path,
    displayChars: source.displayContent.length,
    originalChars: source.content.length,
  };
}

async function resolveCompressionSource(input: {
  tool: string;
  displayOutput: string;
  metadata: unknown;
  maxOutputChars: number;
  readOutputFile: (input: {
    tool: string;
    pathRef: string;
    maxOutputChars: number;
  }) => Promise<TrustedOutputFileReadResult>;
}): Promise<CompressionSource> {
  const metadata = metadataRecord(input.metadata);
  const pathRef = metadataOutputPath(metadata);
  const fallback: CompressionSource = {
    kind: "toolOutput",
    content: input.displayOutput,
    displayContent: input.displayOutput,
  };

  if (!pathRef || !looksLikeTruncatedOutput(input.displayOutput, metadata)) {
    return fallback;
  }

  const result = await input.readOutputFile({
    tool: input.tool,
    pathRef,
    maxOutputChars: input.maxOutputChars,
  });
  if (!result.ok || result.content === undefined) {
    return {
      ...fallback,
      path: result.path,
      readError: result.reason,
      tooLarge: result.tooLarge,
    };
  }

  return {
    kind: "outputPath",
    content: result.content,
    displayContent: input.displayOutput,
    path: result.path,
  };
}

export const HeadroomNativePlugin: Plugin = async (pluginInput, options = {}) => {
  const config = normalizeConfig(options as HeadroomPluginOptions);
  const basePath = pluginBasePath(pluginInput);
  const store = await createCCRStore(resolveStorageConfig(config.storage, basePath));
  const engine = new NativeHeadroomCompatibleEngine(store);
  const sessionIntents = new SessionIntentStore();
  const telemetry = new LocalTelemetryAggregator({
    requestedAdapter: store.diagnostics.requested,
    activeAdapter: store.diagnostics.active,
    ...(store.diagnostics.fallbackReason
      ? { fallbackReason: store.diagnostics.fallbackReason }
      : {}),
  });
  const outputFileSource = createTrustedOutputFileSource(
    config.outputFiles,
    basePath,
  );

  async function emitDebug(
    record: DebugTraceRecord,
    output: { metadata: any },
  ): Promise<void> {
    if (!config.debug) {
      return;
    }

    const fileWrite = await appendDebugRecord(
      config,
      basePath,
      record,
    );

    if (shouldWriteDebugMetadata(config)) {
      output.metadata = {
        ...(output.metadata ?? {}),
        headroom: {
          ...((output.metadata ?? {}).headroom ?? {}),
          debug: debugRecordForLevel(record, config.debugLevel),
          ...(shouldWriteDebugFile(config)
            ? {
                debugFile: {
                  path: fileWrite.path,
                  written: fileWrite.written,
                  ...(fileWrite.error ? { error: fileWrite.error } : {}),
                },
              }
            : {}),
        },
      };
    }
  }

  function createDebugRecord(input: {
    tool: string;
    sessionID: string;
    callID: string;
    decision: DebugDecision;
    reason?: string;
    originalOutput: string;
    originalTokens: number;
    source?: CompressionSource;
    policy?: ResolvedToolPolicy;
    thresholdChars?: number;
    thresholdTokens?: number;
  }): DebugTraceRecord {
    return {
      version: 2,
      time: new Date().toISOString(),
      sessionID: input.sessionID,
      callID: input.callID,
      tool: input.tool,
      decision: input.decision,
      reason: input.reason,
      ...(input.policy
        ? {
            policy: {
              ruleId: input.policy.ruleId,
              source: input.policy.source,
              action: input.policy.action,
              strength: input.policy.strength,
            },
          }
        : {}),
      ...(input.source ? { source: sourceDebug(input.source) } : {}),
      threshold: {
        chars: input.thresholdChars ?? config.thresholdChars,
        tokens: input.thresholdTokens ?? config.thresholdTokens,
        maxOutputChars: config.maxOutputChars,
      },
      sizes: {
        originalChars: input.originalOutput.length,
        originalTokens: input.originalTokens,
      },
    };
  }

  return {
    "chat.message": async (input, output) => {
      sessionIntents.update(input.sessionID, output.parts);
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        await store.deleteSession(event.properties.info.id);
        engine.deleteSessionState(event.properties.info.id);
        telemetry.deleteSession(event.properties.info.id);
        sessionIntents.delete(event.properties.info.id);
      }
    },
    dispose: async () => {
      engine.clearSessionState();
      sessionIntents.clear();
      await store.close();
    },
    tool: {
      headroom_retrieve: createRetrieveTool(engine, (event) =>
        telemetry.recordRetrieval(event),
      ),
      headroom_stats: createStatsTool(engine, telemetry),
    },
    "tool.execute.after": async (input, output) => {
      const startedAt = performance.now();
      let failurePolicyContext:
        | {
            policy: ResolvedToolPolicy;
            thresholdChars: number;
            thresholdTokens: number;
          }
        | undefined;
      let failureSource: CompressionSource | undefined;
      const complete = async (record: DebugTraceRecord): Promise<void> => {
        try {
          telemetry.recordCompression({
            sessionID: input.sessionID,
            outcome:
              record.decision === "compressed"
                ? "compressed"
                : record.decision === "error"
                  ? "error"
                  : "skipped",
            reason:
              record.decision === "compressed"
                ? "compressed"
                : telemetryReason(record.reason),
            estimatedTokensSaved: record.sizes.tokensSaved ?? 0,
            latencyMs: Math.max(0, performance.now() - startedAt),
          });
        } catch {
          // Local telemetry must never change the hook result.
        }
        await emitDebug(record, output);
      };
      try {
        const displayOutput = output.output ?? "";
        const policy = resolveToolPolicy(input.tool, config.toolPolicy);
        const thresholdChars =
          policy.minimum === "always"
            ? 0
            : policy.minimum?.chars ?? config.thresholdChars;
        const thresholdTokens =
          policy.minimum === "always"
            ? 0
            : policy.minimum?.tokens ?? config.thresholdTokens;
        const policyDebugContext = {
          policy,
          thresholdChars,
          thresholdTokens,
        };
        failurePolicyContext = policyDebugContext;
        if (policy.action === "preserve") {
          const source: CompressionSource = {
            kind: "toolOutput",
            content: displayOutput,
            displayContent: displayOutput,
          };
          const originalTokens = estimateTokens(displayOutput);
          await complete(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason:
                policy.source === "user"
                  ? "user_preserve"
                  : policy.source === "compatibility"
                    ? "legacy_skip_tool"
                    : policy.source === "default"
                      ? "default_preserve"
                      : "builtin_preserve",
              originalOutput: displayOutput,
              originalTokens,
              source,
              ...policyDebugContext,
            }),
          );
          return;
        }
        const source = await resolveCompressionSource({
          tool: input.tool,
          displayOutput,
          metadata: output.metadata,
          maxOutputChars: config.maxOutputChars,
          readOutputFile: outputFileSource.read,
        });
        failureSource = source;
        const originalOutput = source.content;
        const originalTokens = estimateTokens(originalOutput);
        if (source.tooLarge) {
          await complete(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: "too_large",
              originalOutput,
              originalTokens,
              source,
              ...policyDebugContext,
            }),
          );
          return;
        }
        if (source.readError) {
          await complete(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: "source_denied",
              originalOutput,
              originalTokens,
              source,
              ...policyDebugContext,
            }),
          );
          return;
        }
        if (!originalOutput || containsCCRMarker(originalOutput)) {
          await complete(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: "empty_or_marked",
              originalOutput,
              originalTokens,
              source,
              ...policyDebugContext,
            }),
          );
          return;
        }
        if (originalOutput.length > config.maxOutputChars) {
          await complete(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: "too_large",
              originalOutput,
              originalTokens,
              source,
              ...policyDebugContext,
            }),
          );
          return;
        }

        if (
          originalOutput.length < thresholdChars &&
          originalTokens < thresholdTokens
        ) {
          await complete(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: "below_threshold",
              originalOutput,
              originalTokens,
              source,
              ...policyDebugContext,
            }),
          );
          return;
        }

        const result = await engine.compress({
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          args: input.args,
          intent: sessionIntents.get(input.sessionID),
          output: originalOutput,
          ttlMs: (policy.ccr?.ttlHours ?? config.ttlHours) * 60 * 60 * 1000,
          strength: policy.strength,
          retrieveDefaults: {
            mode: policy.retrieve?.defaultMode ?? "summary",
            ...(policy.retrieve?.maxChars !== undefined
              ? { maxChars: policy.retrieve.maxChars }
              : policy.retrieve?.defaultMode === "full"
                ? {}
                : { maxChars: 12_000 }),
          },
        });
        if (!result.changed) {
          await complete(
            {
              ...createDebugRecord({
                ...input,
                decision: "unchanged",
                reason: result.reason ?? "no_savings",
                originalOutput,
                originalTokens,
                source,
                ...policyDebugContext,
              }),
              ...(result.debug ?? {}),
              sizes: {
                originalChars: originalOutput.length,
                originalTokens,
                compressedChars: result.output.length,
                compressedTokens: result.compressedTokens,
                tokensSaved: 0,
              },
            },
          );
          return;
        }

        output.output = result.output;
        output.metadata = {
          ...(output.metadata ?? {}),
          headroom: {
            engine: engine.name,
            strategy: result.strategy,
            hash: result.hash,
            originalTokens: result.originalTokens,
            compressedTokens: result.compressedTokens,
            tokensSaved: Math.max(
              0,
              result.originalTokens - result.compressedTokens,
            ),
            ...(outputPathSourceMetadata(source)
              ? { source: outputPathSourceMetadata(source) }
              : {}),
          },
        };
        await complete(
          {
            ...createDebugRecord({
              ...input,
              decision: "compressed",
              originalOutput,
              originalTokens,
              source,
              ...policyDebugContext,
            }),
            ...(result.debug ?? {}),
            sizes: {
              originalChars: originalOutput.length,
              originalTokens: result.originalTokens,
              compressedChars: result.output.length,
              compressedTokens: result.compressedTokens,
              tokensSaved: Math.max(
                0,
                result.originalTokens - result.compressedTokens,
              ),
            },
          },
        );
      } catch {
        const originalOutput = output.output ?? "";
        await complete(
          createDebugRecord({
            ...input,
            decision: "error",
            reason: "hook_error",
            originalOutput,
            originalTokens: estimateTokens(originalOutput),
            ...(failureSource ? { source: failureSource } : {}),
            ...(failurePolicyContext ?? {}),
          }),
        );
        return;
      }
    },
  };
};

export default HeadroomNativePlugin;
