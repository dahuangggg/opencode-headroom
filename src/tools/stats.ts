import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import type { CompressionEngine } from "../engine/types.js";

const z = tool.schema;

export function createStatsTool(engine: CompressionEngine): ToolDefinition {
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
      return result.output;
    },
  });
}
