import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

const DECLARATION_RE =
  /^\s*(?:(?:export|public|private|protected|static|abstract|default|async|pub)\s+)*(?:function|class|interface|type|enum|namespace|def|fn|struct|impl|trait|func)\b|^(?:export\s+)?(?:const|let|var)\b|^\s*(?:package|#include|using\s+namespace)\b/;
const IMPORT_RE = /^\s*(?:import\b|from\s+\S+\s+import\b|require\s*\()/;
const ERROR_RE = /\b(?:throw|raise|panic!|fatal|error|exception|failed)\b/i;

function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$]+/u)
    .filter((word) => word.length > 2);
}

function requiredLine(line: string, words: string[]): boolean {
  if (
    IMPORT_RE.test(line) ||
    DECLARATION_RE.test(line) ||
    ERROR_RE.test(line) ||
    /^\s*[{}]\s*;?\s*$/.test(line)
  ) {
    return true;
  }
  const lower = line.toLowerCase();
  return words.some((word) => lower.includes(word));
}

export function compressCode(input: CompressorInput): CompressorResult {
  const lines = input.content.split(/\r?\n/);
  if (lines.length < 30) {
    return {
      changed: false,
      output: input.content,
      strategy: "code",
      reason: "too_few_lines",
    };
  }

  const words = queryWords(input.query);
  const selected = new Set<number>([0, lines.length - 1]);
  lines.forEach((line, index) => {
    if (requiredLine(line, words)) {
      selected.add(index);
      if (ERROR_RE.test(line)) {
        if (index > 0) selected.add(index - 1);
        if (index + 1 < lines.length) selected.add(index + 1);
      }
    }
  });

  const output: string[] = [];
  let omitted = 0;
  let cursor = 0;
  for (const index of [...selected].sort((left, right) => left - right)) {
    if (index > cursor) {
      const count = index - cursor;
      omitted += count;
      output.push(`// … ${count} lines`);
    }
    output.push(lines[index] ?? "");
    cursor = index + 1;
  }
  if (cursor < lines.length) {
    const count = lines.length - cursor;
    omitted += count;
    output.push(`// … ${count} lines`);
  }
  output.push(formatRetrieveMarker(input.hash));
  const candidate = output.join("\n");
  if (omitted === 0 || candidate.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "code",
      reason: omitted === 0 ? "nothing_dropped" : "no_savings",
    };
  }

  return {
    changed: true,
    output: candidate,
    strategy: "code",
    debug: {
      compressor: {
        strategy: "code",
        originalChars: input.content.length,
        compressedChars: candidate.length,
        kept: { lines: selected.size },
        dropped: { lines: omitted },
      },
    },
  };
}
