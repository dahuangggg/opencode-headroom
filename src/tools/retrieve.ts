import { tool } from "@opencode-ai/plugin";

import type { CompressionEngine } from "../engine/types.js";
import { isValidCCRHash } from "../markers.js";

const z = tool.schema;

export function createRetrieveTool(engine: CompressionEngine) {
  return tool({
    description:
      "Retrieve exact original content from opencode-headroom CCR by 24-character hash. Use when compressed tool output contains a CCR or Retrieve marker.",
    args: {
      hash: z
        .string()
        .describe("24-character CCR hash from a compressed tool output marker"),
      query: z
        .string()
        .optional()
        .describe("Optional reason or search query for retrieval stats"),
    },
    async execute(args) {
      if (!isValidCCRHash(args.hash)) {
        return "Invalid hash format. Expected 24 hex characters.";
      }
      const result = await engine.retrieve(args.hash, args.query);
      return result.output;
    },
  });
}
