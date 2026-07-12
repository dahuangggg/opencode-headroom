import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import type { CompressionEngine } from "../engine/types.js";
import { isValidCCRHash } from "../markers.js";
import type {
  RetrievalTelemetryInput,
  RetrievalTelemetryMode,
} from "../telemetry.js";
import { estimateTokens } from "../token.js";

const z = tool.schema;

function requestedMode(args: {
  mode?: RetrievalTelemetryMode;
  query?: string;
  startLine?: number;
  endLine?: number;
}): RetrievalTelemetryMode | undefined {
  if (args.mode) {
    return args.mode;
  }
  if (args.startLine !== undefined || args.endLine !== undefined) {
    return "range";
  }
  if (args.query?.trim()) {
    return "query";
  }
  return undefined;
}

function modeFromOutput(output: string): RetrievalTelemetryMode | undefined {
  const value = /^mode: (full|query|range|head|tail|summary)$/m.exec(output)?.[1];
  return value as RetrievalTelemetryMode | undefined;
}

export function createRetrieveTool(
  engine: CompressionEngine,
  observe?: (input: RetrievalTelemetryInput) => void,
): ToolDefinition {
  return tool({
    description:
      "Retrieve content from the current OpenCode session's opencode-headroom CCR by 24-character hash. Prefer mode=query, mode=range, mode=head, or mode=tail to avoid returning huge content. Use mode=full only when exact full original content is required.",
    args: {
      hash: z
        .string()
        .describe("24-character CCR hash from a compressed tool output marker"),
      mode: z
        .enum(["full", "query", "range", "head", "tail", "summary"])
        .optional()
        .describe("Retrieval mode. Defaults to a bounded summary unless query or line range is provided. Use full explicitly for the exact original."),
      query: z
        .string()
        .optional()
        .describe("Search query for mode=query. Returns matching lines with context."),
      startLine: z
        .number()
        .optional()
        .describe("1-based start line for mode=range"),
      endLine: z
        .number()
        .optional()
        .describe("1-based end line for mode=range"),
      lines: z
        .number()
        .optional()
        .describe("Number of lines for mode=head or mode=tail"),
      contextLines: z
        .number()
        .optional()
        .describe("Context lines before/after each query match"),
      maxMatches: z
        .number()
        .optional()
        .describe("Maximum query matches to include"),
      maxChars: z
        .number()
        .optional()
        .describe("Maximum characters to return for partial modes"),
    },
    async execute(args, context) {
      const startedAt = performance.now();
      if (!isValidCCRHash(args.hash)) {
        const output = "Invalid hash format. Expected 24 hex characters.";
        try {
          observe?.({
            sessionID: context.sessionID,
            mode: requestedMode(args) ?? "summary",
            outcome: "miss",
            outputTokens: estimateTokens(output),
            latencyMs: Math.max(0, performance.now() - startedAt),
          });
        } catch {
          // Telemetry must never change tool behaviour.
        }
        return output;
      }
      const result = await engine.retrieve(
        args.hash,
        {
          mode: args.mode,
          query: args.query,
          startLine: args.startLine,
          endLine: args.endLine,
          lines: args.lines,
          contextLines: args.contextLines,
          maxMatches: args.maxMatches,
          maxChars: args.maxChars,
        },
        context.sessionID,
      );
      try {
        observe?.({
          sessionID: context.sessionID,
          mode:
            requestedMode(args) ??
            modeFromOutput(result.output) ??
            (result.found ? "full" : "summary"),
          outcome: result.found ? "hit" : "miss",
          outputTokens: estimateTokens(result.output),
          latencyMs: Math.max(0, performance.now() - startedAt),
        });
      } catch {
        // Telemetry must never change tool behaviour.
      }
      return result.output;
    },
  });
}
