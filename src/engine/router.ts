import { compressCode } from "../compressors/code.js";
import { compressDiff } from "../compressors/diff.js";
import { compressJson } from "../compressors/json.js";
import { compressLog } from "../compressors/log.js";
import { compressSearch } from "../compressors/search.js";
import { compressTabular, parseTabular } from "../compressors/tabular.js";
import { compressText } from "../compressors/text.js";
import { gateCompressionCandidate } from "./pipeline.js";
import type {
  CompressorInput,
  CompressorResult,
  DetectionResult,
} from "../compressors/types.js";

const ENVELOPE_RE =
  /^(?<prefix>\s*(?:<returncode>\s*-?\d+\s*<\/returncode>\s*)?<(?<tag>output|stdout|stderr|tool_result|result)>\n?)(?<body>[\s\S]*?)(?<suffix>\n?<\/\k<tag>>\s*)$/;
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
const CODE_DECLARATION_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[$\w]+\s*\(/,
  /^\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum|namespace)\s+[$\w]+/,
  /^\s*(?:async\s+)?def\s+\w+\s*\(/,
  /^\s*class\s+\w+(?:\([^)]*\))?\s*:/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+\s*\(/,
  /^\s*(?:package\s+\w+|func\s+(?:\([^)]*\)\s*)?\w+\s*\()/,
  /^\s*#include\s+[<"]|^\s*using\s+namespace\s+\w+/,
];
const CODE_SUPPORT_PATTERNS = [
  /^\s*(?:const|let|var)\s+[$\w]+(?:\s*:[^=]+)?\s*=/,
  /^\s*(?:return|throw|yield)\b/,
  /^\s*(?:if|for|while|switch|catch)\s*\(/,
  /^\s*(?:import|export)\s+/,
  /^\s*(?:from\s+\S+\s+import|import\s+\S+)/,
  /^\s*(?:pub\s+)?(?:struct|impl|trait|enum)\b/,
];

interface RoutedContent {
  payload: string;
  render(payload: string): string;
}

interface ExplicitSection {
  tag: string;
  before: string;
  opening: string;
  leading: string;
  payload: string;
  trailing: string;
  closing: string;
}

interface ExplicitSections {
  sections: ExplicitSection[];
  tail: string;
}

function routeContent(content: string): RoutedContent {
  const match = ENVELOPE_RE.exec(content);
  const body = match?.groups?.body;
  const prefix = match?.groups?.prefix;
  const suffix = match?.groups?.suffix;
  if (!body || !body.trim() || prefix === undefined || suffix === undefined) {
    return {
      payload: content,
      render: (payload) => payload,
    };
  }

  return {
    payload: body.trim(),
    render: (payload) => `${prefix}${payload}${suffix}`,
  };
}

function routeExplicitSections(content: string): ExplicitSections | undefined {
  const sectionPattern =
    /<(?<tag>stdout|stderr|output|tool_result|result)>(?<body>[\s\S]*?)<\/\k<tag>>/g;
  const sections: ExplicitSection[] = [];
  let cursor = 0;
  for (const match of content.matchAll(sectionPattern)) {
    const tag = match.groups?.tag;
    const body = match.groups?.body;
    const index = match.index;
    if (!tag || body === undefined || index === undefined) {
      return undefined;
    }

    const before = content.slice(cursor, index);
    const allowedGap =
      sections.length === 0
        ? /^\s*(?:<returncode>\s*-?\d+\s*<\/returncode>\s*)?$/
        : /^\s*$/;
    if (!allowedGap.test(before)) {
      return undefined;
    }

    const leading = /^\s*/u.exec(body)?.[0] ?? "";
    const remainder = body.slice(leading.length);
    const trailing = remainder ? /\s*$/u.exec(remainder)?.[0] ?? "" : "";
    const payload = remainder.slice(0, remainder.length - trailing.length);
    sections.push({
      tag,
      before,
      opening: `<${tag}>`,
      leading,
      payload,
      trailing,
      closing: `</${tag}>`,
    });
    cursor = index + match[0].length;
  }

  const tail = content.slice(cursor);
  if (sections.length < 2 || !/^\s*$/.test(tail)) {
    return undefined;
  }
  return { sections, tail };
}

function compressExplicitSections(
  input: CompressorInput,
): CompressorResult | undefined {
  const routed = routeExplicitSections(input.content);
  if (!routed) {
    return undefined;
  }

  let changed = false;
  const debugSections: Array<Record<string, unknown>> = [];
  const output = [
    ...routed.sections.map((section) => {
      const result = compressByContentType({ ...input, content: section.payload });
      changed ||= result.changed;
      debugSections.push({
        tag: section.tag,
        kind: result.debug?.router?.kind ?? result.strategy,
        changed: result.changed,
        ...(result.reason ? { reason: result.reason } : {}),
      });
      return [
        section.before,
        section.opening,
        section.leading,
        result.output,
        section.trailing,
        section.closing,
      ].join("");
    }),
    routed.tail,
  ].join("");
  const debug = {
    router: {
      kind: "text" as const,
      confidence: 1,
      metadata: { mixed: true, sections: debugSections },
    },
  };

  if (!changed || output.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "text",
      reason: changed ? "mixed_no_savings" : "mixed_passthrough",
      debug,
    };
  }
  const gate = gateCompressionCandidate({
    original: input.content,
    candidate: output,
    kind: "text",
  });
  if (!gate.accepted) {
    return {
      changed: false,
      output: input.content,
      strategy: "text",
      reason: `candidate_${gate.reason}`,
      debug,
    };
  }
  return { changed: true, output, strategy: "text", debug };
}

export function stripDetectionEnvelope(content: string): string {
  return routeContent(content).payload;
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

function detectCode(content: string): DetectionResult | undefined {
  const lines = content
    .split(/\r?\n/)
    .slice(0, 100)
    .filter((line) => line.trim());
  let declarations = 0;
  let patternMatches = 0;
  for (const line of lines) {
    if (CODE_DECLARATION_PATTERNS.some((pattern) => pattern.test(line))) {
      declarations += 1;
      patternMatches += 1;
      continue;
    }
    if (CODE_SUPPORT_PATTERNS.some((pattern) => pattern.test(line))) {
      patternMatches += 1;
    }
  }

  if (declarations < 1 || patternMatches < 3) {
    return undefined;
  }

  return {
    kind: "code",
    confidence: Math.min(1, 0.5 + patternMatches * 0.03),
    metadata: {
      code: true,
      declarations,
      patternMatches,
    },
  };
}

function detectPayloadType(probe: string): DetectionResult {
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
  const table = parseTabular(probe);
  if (table) {
    return {
      kind: "table",
      confidence: 0.95,
      metadata: { format: table.delimiter, rows: table.rows.length },
    };
  }
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

  const code = detectCode(probe);
  if (code) {
    return code;
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

export function detectContentType(content: string): DetectionResult {
  return detectPayloadType(routeContent(content).payload);
}

export function compressByContentType(input: CompressorInput): CompressorResult {
  const mixed = compressExplicitSections(input);
  if (mixed) {
    return mixed;
  }

  const routed = routeContent(input.content);
  const detection = detectPayloadType(routed.payload);
  const attachRouterDebug = (result: CompressorResult): CompressorResult => {
    const gate = result.changed
      ? gateCompressionCandidate({
          original: routed.payload,
          candidate: result.output,
          kind: detection.kind,
        })
      : undefined;
    const accepted = !gate || gate.accepted;
    return {
      ...result,
      changed: result.changed && accepted,
      output:
        result.changed && accepted ? routed.render(result.output) : input.content,
      ...(!accepted && gate && !gate.accepted
        ? { reason: `candidate_${gate.reason}` }
        : {}),
      debug: {
        ...(result.debug ?? {}),
        router: {
          kind: detection.kind,
          confidence: detection.confidence,
          metadata: detection.metadata,
        },
      },
    };
  };

  if (detection.kind === "code") {
    return attachRouterDebug(compressCode({ ...input, content: routed.payload }));
  }

  if (detection.kind === "diff") {
    return attachRouterDebug(compressDiff({ ...input, content: routed.payload }));
  }
  if (detection.kind === "json") {
    return attachRouterDebug(compressJson({ ...input, content: routed.payload }));
  }
  if (detection.kind === "search") {
    return attachRouterDebug(compressSearch({ ...input, content: routed.payload }));
  }
  if (detection.kind === "log") {
    return attachRouterDebug(compressLog({ ...input, content: routed.payload }));
  }
  if (detection.kind === "table") {
    return attachRouterDebug(
      compressTabular({ ...input, content: routed.payload }),
    );
  }
  return attachRouterDebug(compressText({ ...input, content: routed.payload }));
}
