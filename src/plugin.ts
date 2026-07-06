import type { Plugin } from "@opencode-ai/plugin";

import {
  normalizeConfig,
  shouldSkipTool,
  type HeadroomPluginOptions,
} from "./config.js";
import {
  appendDebugRecord,
  debugRecordForLevel,
  shouldWriteDebugMetadata,
  type DebugDecision,
  type DebugTraceRecord,
} from "./debug.js";
import { NativeHeadroomCompatibleEngine } from "./engine/native.js";
import { containsCCRMarker } from "./markers.js";
import { createCCRStore } from "./store/ccr.js";
import { estimateTokens } from "./token.js";
import { createRetrieveTool } from "./tools/retrieve.js";
import { createStatsTool } from "./tools/stats.js";

export type { HeadroomPluginOptions } from "./config.js";

export const HeadroomNativePlugin: Plugin = async (pluginInput, options = {}) => {
  const config = normalizeConfig(options as HeadroomPluginOptions);
  const store = await createCCRStore(config.storage);
  const engine = new NativeHeadroomCompatibleEngine(store);

  async function emitDebug(
    record: DebugTraceRecord,
    output: { metadata: any },
  ): Promise<void> {
    if (!config.debug) {
      return;
    }

    if (shouldWriteDebugMetadata(config)) {
      output.metadata = {
        ...(output.metadata ?? {}),
        headroom: {
          ...((output.metadata ?? {}).headroom ?? {}),
          debug: debugRecordForLevel(record, config.debugLevel),
        },
      };
    }

    await appendDebugRecord(config, pluginInput.worktree, record);
  }

  function createDebugRecord(input: {
    tool: string;
    sessionID: string;
    callID: string;
    decision: DebugDecision;
    reason?: string;
    originalOutput: string;
    originalTokens: number;
  }): DebugTraceRecord {
    return {
      version: 1,
      time: new Date().toISOString(),
      sessionID: input.sessionID,
      callID: input.callID,
      tool: input.tool,
      decision: input.decision,
      reason: input.reason,
      threshold: {
        chars: config.thresholdChars,
        tokens: config.thresholdTokens,
        maxOutputChars: config.maxOutputChars,
      },
      sizes: {
        originalChars: input.originalOutput.length,
        originalTokens: input.originalTokens,
      },
    };
  }

  return {
    tool: {
      headroom_retrieve: createRetrieveTool(engine),
      headroom_stats: createStatsTool(engine),
    },
    "tool.execute.after": async (input, output) => {
      try {
        const originalOutput = output.output ?? "";
        const originalTokens = estimateTokens(originalOutput);
        if (shouldSkipTool(input.tool, config)) {
          await emitDebug(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: "skip_tool",
              originalOutput,
              originalTokens,
            }),
            output,
          );
          return;
        }
        if (!originalOutput || containsCCRMarker(originalOutput)) {
          await emitDebug(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: "empty_or_marked",
              originalOutput,
              originalTokens,
            }),
            output,
          );
          return;
        }
        if (originalOutput.length > config.maxOutputChars) {
          await emitDebug(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: "too_large",
              originalOutput,
              originalTokens,
            }),
            output,
          );
          return;
        }

        if (
          originalOutput.length < config.thresholdChars &&
          originalTokens < config.thresholdTokens
        ) {
          await emitDebug(
            createDebugRecord({
              ...input,
              decision: "skipped",
              reason: "below_threshold",
              originalOutput,
              originalTokens,
            }),
            output,
          );
          return;
        }

        const result = await engine.compress({
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          args: input.args,
          output: originalOutput,
          ttlMs: config.ttlHours * 60 * 60 * 1000,
        });
        if (!result.changed) {
          await emitDebug(
            {
              ...createDebugRecord({
                ...input,
                decision: "unchanged",
                reason: result.reason ?? "no_savings",
                originalOutput,
                originalTokens,
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
            output,
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
          },
        };
        await emitDebug(
          {
            ...createDebugRecord({
              ...input,
              decision: "compressed",
              originalOutput,
              originalTokens,
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
          output,
        );
      } catch {
        if (config.debug) {
          const originalOutput = output.output ?? "";
          await emitDebug(
            createDebugRecord({
              ...input,
              decision: "error",
              reason: "hook_error",
              originalOutput,
              originalTokens: estimateTokens(originalOutput),
            }),
            output,
          );
        }
        return;
      }
    },
  };
};

export default HeadroomNativePlugin;
