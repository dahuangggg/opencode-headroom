import { isAbsolute, resolve } from "node:path";

import type { Hooks, Plugin } from "@opencode-ai/plugin";

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
import { decideContextProtection } from "./engine/context-protection.js";
import { NativeHeadroomCompatibleEngine } from "./engine/native.js";
import { containsCCRMarker } from "./markers.js";
import { resolveToolPolicy, type ResolvedToolPolicy } from "./policy.js";
import { ContextLifecycleManager } from "./session/context-lifecycle.js";
import { SessionIntentStore } from "./session/intent.js";
import { deduplicateMessageToolOutputs } from "./session/message-dedup.js";
import { ReadLifecycleManager } from "./session/read-lifecycle.js";
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
import { shouldPreserveRawFileRead } from "./read-protection.js";
import { createRetrieveTool } from "./tools/retrieve.js";
import { createStatsTool } from "./tools/stats.js";

export type { HeadroomPluginOptions, HeadroomProfile } from "./config.js";

type CompressionSourceKind = "toolOutput" | "outputPath";

interface CompressionSource {
  kind: CompressionSourceKind;
  content: string;
  displayContent: string;
  path?: string;
  readError?: string;
  tooLarge?: boolean;
}

interface CompletedToolFallbackPart {
  readonly source: object;
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
  readonly state: {
    input: unknown;
    output: string;
    title?: unknown;
    metadata?: unknown;
  };
}

const MAX_PENDING_MCP_SESSIONS = 256;
const MAX_PENDING_MCP_CALLS_PER_SESSION = 2_048;

class PendingMcpToolCalls {
  private readonly sessions = new Map<string, Set<string>>();

  get empty(): boolean {
    return this.sessions.size === 0;
  }

  private key(callID: string, tool: string): string {
    return JSON.stringify([callID, tool]);
  }

  mark(sessionID: string, callID: string, tool: string): void {
    if (!sessionID || !callID || !tool) return;
    let calls = this.sessions.get(sessionID);
    if (!calls) {
      if (this.sessions.size >= MAX_PENDING_MCP_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      calls = new Set<string>();
      this.sessions.set(sessionID, calls);
    }
    const key = this.key(callID, tool);
    if (!calls.has(key) && calls.size >= MAX_PENDING_MCP_CALLS_PER_SESSION) {
      const oldest = calls.values().next().value;
      if (oldest !== undefined) calls.delete(oldest);
    }
    calls.delete(key);
    calls.add(key);
  }

  has(sessionID: string, callID: string, tool: string): boolean {
    return this.sessions.get(sessionID)?.has(this.key(callID, tool)) ?? false;
  }

  delete(sessionID: string, callID: string, tool: string): void {
    const calls = this.sessions.get(sessionID);
    if (!calls) return;
    calls.delete(this.key(callID, tool));
    if (calls.size === 0) this.sessions.delete(sessionID);
  }

  deleteSession(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  clear(): void {
    this.sessions.clear();
  }
}

const COMPRESSION_TELEMETRY_REASONS = new Set<CompressionTelemetryReason>([
  "compressed",
  "below_threshold",
  "legacy_skip_tool",
  "builtin_preserve",
  "read_protected",
  "protected_error_output",
  "protected_recent_code",
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
  "strategy_circuit_open",
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

function completedToolFallbackPart(
  value: unknown,
): CompletedToolFallbackPart | undefined {
  if (Array.isArray(value)) return undefined;
  const part = metadataRecord(value);
  if (Array.isArray(part?.state)) return undefined;
  const state = metadataRecord(part?.state);
  if (
    part?.type !== "tool" ||
    typeof part.tool !== "string" ||
    typeof part.sessionID !== "string" ||
    typeof part.callID !== "string" ||
    state?.status !== "completed" ||
    typeof state.output !== "string"
  ) {
    return undefined;
  }
  return {
    source: part,
    tool: part.tool,
    sessionID: part.sessionID,
    callID: part.callID,
    state: state as unknown as CompletedToolFallbackPart["state"],
  };
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
  const engine = new NativeHeadroomCompatibleEngine(store, {
    losslessThenLossy: config.profile === "coding",
  });
  const sessionIntents = new SessionIntentStore();
  const contextLifecycle = new ContextLifecycleManager();
  const pendingMcpToolCalls = new PendingMcpToolCalls();
  const readLifecycle = config.readLifecycle
    ? new ReadLifecycleManager(store, {
        basePath,
        ttlMs: Math.min(
          config.ttlHours * 60 * 60 * 1000,
          Number.MAX_SAFE_INTEGER,
        ),
        maxReplacements: config.storage.maxEntries,
      })
    : undefined;
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

  const hooks: Hooks = {
    "chat.message": async (input, output) => {
      sessionIntents.update(input.sessionID, output.parts);
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const processedFallbacks: Array<{
          sessionID: string;
          callID: string;
          tool: string;
        }> = [];
        await contextLifecycle.run(output.messages, async (mutationWindow) => {
          await readLifecycle?.apply(output.messages, mutationWindow);
          if (!pendingMcpToolCalls.empty) {
            for (const message of output.messages) {
              for (const part of message.parts) {
                const candidate = completedToolFallbackPart(part);
                if (
                  !candidate ||
                  !pendingMcpToolCalls.has(
                    candidate.sessionID,
                    candidate.callID,
                    candidate.tool,
                  )
                ) {
                  continue;
                }
                processedFallbacks.push({
                  sessionID: candidate.sessionID,
                  callID: candidate.callID,
                  tool: candidate.tool,
                });
                if (
                  !mutationWindow.canMutateToolPart(candidate.source) ||
                  containsCCRMarker(candidate.state.output)
                ) {
                  continue;
                }

                const assembled = {
                  title:
                    typeof candidate.state.title === "string"
                      ? candidate.state.title
                      : candidate.tool,
                  output: candidate.state.output,
                  // Compress the final AI-visible projection only. In particular,
                  // do not follow OpenCode outputPath metadata from request history.
                  metadata: {} as Record<string, unknown>,
                };
                await hooks["tool.execute.after"]!(
                  {
                    tool: candidate.tool,
                    sessionID: candidate.sessionID,
                    callID: candidate.callID,
                    args: candidate.state.input ?? {},
                  },
                  assembled,
                );
                candidate.state.output = assembled.output;
                const headroom = metadataRecord(assembled.metadata)?.headroom;
                if (headroom !== undefined) {
                  candidate.state.metadata = {
                    ...(metadataRecord(candidate.state.metadata) ?? {}),
                    headroom,
                  };
                }
              }
            }
          }
          deduplicateMessageToolOutputs(output.messages, mutationWindow);
        });
        for (const item of processedFallbacks) {
          pendingMcpToolCalls.delete(item.sessionID, item.callID, item.tool);
        }
      } catch {
        // Request transforms must fail open so the model still receives context.
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id;
        await contextLifecycle.runSessionExclusive(sessionID, async () => {
          try {
            await store.deleteSession(sessionID);
          } finally {
            engine.deleteSessionState(sessionID);
            telemetry.deleteSession(sessionID);
            sessionIntents.delete(sessionID);
            pendingMcpToolCalls.deleteSession(sessionID);
            contextLifecycle.deleteSession(sessionID);
            readLifecycle?.deleteSession(sessionID);
          }
        });
      }
    },
    dispose: async () => {
      await contextLifecycle.closeAndDrain();
      engine.clearSessionState();
      sessionIntents.clear();
      pendingMcpToolCalls.clear();
      contextLifecycle.clear();
      readLifecycle?.clear();
      await store.close();
    },
    tool: {
      headroom_retrieve: createRetrieveTool(engine, (event) =>
        telemetry.recordRetrieval(event),
      ),
      headroom_stats: createStatsTool(engine, telemetry),
    },
    "tool.execute.after": async (input, output) => {
      // OpenCode 1.17.13 passes raw MCP CallToolResult here. Record only the
      // public call identity; the normalized output is handled at transform time.
      if (
        !output ||
        typeof output !== "object" ||
        typeof (output as { title?: unknown }).title !== "string" ||
        typeof (output as { output?: unknown }).output !== "string"
      ) {
        pendingMcpToolCalls.mark(input.sessionID, input.callID, input.tool);
        return;
      }
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
        const policy = shouldPreserveRawFileRead(input.args, displayOutput)
          ? {
              ruleId: "builtin-shell-read",
              source: "builtin" as const,
              action: "preserve" as const,
              strength: config.toolPolicy.default.strength,
            }
          : resolveToolPolicy(input.tool, config.toolPolicy);
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
                policy.ruleId === "builtin-shell-read"
                  ? "read_protected"
                  : policy.source === "user"
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

        const protection =
          config.profile === "coding" && source.kind === "toolOutput"
            ? decideContextProtection(originalOutput)
            : { preserve: false as const };
        if (protection.preserve) {
          await complete(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: protection.reason,
              originalOutput,
              originalTokens,
              source,
              ...policyDebugContext,
            }),
          );
          return;
        }

        const result = await engine.compressWithKnownTokens(
          {
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
          },
          originalTokens,
        );
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

  return hooks;
};

export default HeadroomNativePlugin;
