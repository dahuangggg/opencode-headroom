import { formatRetrieveMarker } from "../markers.js";
import { estimateTokens } from "../token.js";
import { compressCodeAst, isValidCodeSyntax } from "./code-ast.js";
import type { CompressorInput, CompressorResult } from "./types.js";

const MIN_TOKENS_FOR_COMPRESSION = 100;
const MIN_COMPRESSION_RATIO = 0.05;
const MAX_COMPRESSION_RATIO = 0.8;

export function compressCode(input: CompressorInput): CompressorResult {
  const originalTokens = input.originalTokens ?? estimateTokens(input.content);
  if (originalTokens < MIN_TOKENS_FOR_COMPRESSION) {
    return {
      changed: false,
      output: input.content,
      strategy: "code",
      reason: "too_few_tokens",
    };
  }

  const ast = compressCodeAst(input.content, input.query);
  if (!ast.changed || !ast.language) {
    return {
      changed: false,
      output: input.content,
      strategy: "code",
      reason: ast.reason ?? "nothing_to_compress",
    };
  }

  const markerPrefix = ast.language === "python" ? "#" : "//";
  const output = `${ast.output}\n${markerPrefix} ${formatRetrieveMarker(input.hash)}`;
  if (!isValidCodeSyntax(output, ast.language)) {
    return {
      changed: false,
      output: input.content,
      strategy: "code",
      reason: "invalid_syntax",
    };
  }

  const compressedTokens = estimateTokens(output);
  const ratio = compressedTokens / Math.max(1, originalTokens);
  if (ratio < MIN_COMPRESSION_RATIO) {
    return {
      changed: false,
      output: input.content,
      strategy: "code",
      reason: "over_compressed",
    };
  }
  if (ratio >= MAX_COMPRESSION_RATIO) {
    return {
      changed: false,
      output: input.content,
      strategy: "code",
      reason: "insufficient_savings",
    };
  }

  return {
    changed: true,
    output,
    strategy: "code",
    tokenCounts: { original: originalTokens, compressed: compressedTokens },
    debug: {
      compressor: {
        strategy: "code",
        originalChars: input.content.length,
        compressedChars: output.length,
        kept: {
          language: ast.language,
          syntaxValid: true,
        },
        dropped: {
          bodies: ast.compressedBodies,
          lines: ast.omittedLines,
        },
      },
    },
  };
}
