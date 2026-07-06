import { compressJson } from "../compressors/json.js";
import { compressLog } from "../compressors/log.js";
import { compressSearch } from "../compressors/search.js";
import { compressText } from "../compressors/text.js";
import type {
  CompressorInput,
  CompressorResult,
  DetectionResult,
} from "../compressors/types.js";

const ENVELOPE_RE =
  /^\s*(?:<returncode>\s*-?\d+\s*<\/returncode>\s*)?<(?<tag>output|stdout|stderr|tool_result|result)>\n?(?<body>[\s\S]*?)\n?<\/\k<tag>>\s*$/;
const SEARCH_COLON_RE = /^(?<path>[^\s:][^:\n]*):\d+(?=[:\-\s])/;
const SEARCH_CONTEXT_RE = /^(?<path>[^\s:\n][^:\n]*)-\d+(?=[:\-\s])/;
const DIFF_HEADER_RE =
  /^(diff --git|diff --combined |diff --cc |--- a\/|@@\s+-\d+)/;
const DIFF_CHANGE_RE = /^[+-][^+-]/;
const LOG_PATTERNS = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /\b(WARN|WARNING)\b/i,
  /\b(INFO|DEBUG|TRACE)\b/i,
  /^\s*\d{4}-\d{2}-\d{2}/,
  /^\s*\[\d{2}:\d{2}:\d{2}\]/,
  /^npm ERR!|^yarn error|^cargo error/i,
  /Traceback \(most recent call last\)/,
  /^\s*at\s+[\w.$]+\(/,
];

export function stripDetectionEnvelope(content: string): string {
  const match = ENVELOPE_RE.exec(content);
  const body = match?.groups?.body;
  return body && body.trim() ? body.trim() : content;
}

function isSearchLine(line: string): boolean {
  const token = line.trimStart().split(/\s+/, 1)[0] ?? "";
  const match = SEARCH_COLON_RE.exec(token) ?? SEARCH_CONTEXT_RE.exec(token);
  const path = match?.groups?.path;
  if (!path) {
    return false;
  }
  const filename = path.split(/[\\/]/).at(-1) ?? path;
  return path.includes("/") || path.includes("\\") || filename.includes(".");
}

export function detectContentType(content: string): DetectionResult {
  const probe = stripDetectionEnvelope(content);
  if (!probe.trim()) {
    return { kind: "text", confidence: 0, metadata: {} };
  }

  const trimmed = probe.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return { kind: "json", confidence: 1, metadata: {} };
    } catch {
      // Continue detection for invalid JSON-looking content.
    }
  }

  const firstLines = probe.split(/\r?\n/).slice(0, 500);
  const diffHeaders = firstLines.filter((line) =>
    DIFF_HEADER_RE.test(line),
  ).length;
  const diffChanges = firstLines.filter((line) =>
    DIFF_CHANGE_RE.test(line),
  ).length;
  if (diffHeaders > 0) {
    return {
      kind: "diff",
      confidence: Math.min(1, 0.5 + diffHeaders * 0.2 + diffChanges * 0.05),
      metadata: { diffHeaders, diffChanges },
    };
  }

  const searchLines = firstLines.slice(0, 100).filter((line) => line.trim());
  const searchMatches = searchLines.filter((line) => isSearchLine(line)).length;
  if (searchLines.length > 0 && searchMatches / searchLines.length >= 0.3) {
    return {
      kind: "search",
      confidence: Math.min(1, 0.4 + (searchMatches / searchLines.length) * 0.6),
      metadata: {
        matchingLines: searchMatches,
        totalLines: searchLines.length,
      },
    };
  }

  const logLines = firstLines.slice(0, 200).filter((line) => line.trim());
  const logMatches = logLines.filter((line) =>
    LOG_PATTERNS.some((pattern) => pattern.test(line)),
  ).length;
  if (logLines.length > 0 && logMatches / logLines.length >= 0.1) {
    return {
      kind: "log",
      confidence: Math.min(1, 0.3 + (logMatches / logLines.length) * 0.5),
      metadata: { matchingLines: logMatches, totalLines: logLines.length },
    };
  }

  return { kind: "text", confidence: 0.5, metadata: {} };
}

export function compressByContentType(input: CompressorInput): CompressorResult {
  const detection = detectContentType(input.content);
  const attachRouterDebug = (result: CompressorResult): CompressorResult => ({
    ...result,
    debug: {
      ...(result.debug ?? {}),
      router: {
        kind: detection.kind,
        confidence: detection.confidence,
        metadata: detection.metadata,
      },
    },
  });

  if (detection.kind === "diff") {
    return attachRouterDebug({
      changed: false,
      output: input.content,
      strategy: "diff",
      reason: "diff_passthrough",
      debug: {
        compressor: {
          strategy: "diff",
          originalChars: input.content.length,
          compressedChars: input.content.length,
          kept: {},
          dropped: {},
        },
      },
    });
  }
  if (detection.kind === "json") {
    return attachRouterDebug(compressJson(input));
  }
  if (detection.kind === "search") {
    return attachRouterDebug(compressSearch(input));
  }
  if (detection.kind === "log") {
    return attachRouterDebug(compressLog(input));
  }
  return attachRouterDebug(compressText(input));
}
