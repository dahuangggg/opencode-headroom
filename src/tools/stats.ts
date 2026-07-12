import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import type { CompressionEngine } from "../engine/types.js";
import {
  LocalTelemetryAggregator,
  renderTelemetrySnapshot,
} from "../telemetry.js";

const z = tool.schema;

export function createStatsTool(
  engine: CompressionEngine,
  telemetry?: LocalTelemetryAggregator,
): ToolDefinition {
  return tool({
    description:
      "Show opencode-headroom compression and CCR statistics for this session or all active entries.",
    args: {
      sessionOnly: z
        .boolean()
        .optional()
        .describe("When true, only show stats for the current OpenCode session"),
    },
    async execute(args, context) {
      const sessionID = args.sessionOnly ? context.sessionID : undefined;
      const result = await engine.stats(sessionID);
      return telemetry
        ? `${result.output}\n${renderTelemetrySnapshot(telemetry.snapshot(sessionID))}`
        : result.output;
    },
  });
}
