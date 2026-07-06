import type { Plugin } from "@opencode-ai/plugin";

import {
  normalizeConfig,
  shouldSkipTool,
  type HeadroomPluginOptions,
} from "./config.js";
import { NativeHeadroomCompatibleEngine } from "./engine/native.js";
import { containsCCRMarker } from "./markers.js";
import { createCCRStore } from "./store/ccr.js";
import { estimateTokens } from "./token.js";
import { createRetrieveTool } from "./tools/retrieve.js";
import { createStatsTool } from "./tools/stats.js";

export type { HeadroomPluginOptions } from "./config.js";

export const HeadroomNativePlugin: Plugin = async (_input, options = {}) => {
  const config = normalizeConfig(options as HeadroomPluginOptions);
  const store = await createCCRStore(config.storage);
  const engine = new NativeHeadroomCompatibleEngine(store);

  return {
    tool: {
      headroom_retrieve: createRetrieveTool(engine),
      headroom_stats: createStatsTool(engine),
    },
    "tool.execute.after": async (input, output) => {
      try {
        if (shouldSkipTool(input.tool, config)) {
          return;
        }
        if (!output.output || containsCCRMarker(output.output)) {
          return;
        }
        if (output.output.length > config.maxOutputChars) {
          return;
        }

        const tokens = estimateTokens(output.output);
        if (
          output.output.length < config.thresholdChars &&
          tokens < config.thresholdTokens
        ) {
          return;
        }

        const result = await engine.compress({
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
          args: input.args,
          output: output.output,
          ttlMs: config.ttlHours * 60 * 60 * 1000,
        });
        if (!result.changed) {
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
      } catch {
        return;
      }
    },
  };
};

export default HeadroomNativePlugin;
