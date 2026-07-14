import type { ContentKind } from "../compressors/types.js";
import { splitTextSegments } from "../compressors/text.js";
import { estimateTokens } from "../token.js";

export type CandidateRejectionReason =
  | "empty_candidate"
  | "invalid_structure"
  | "protected_fact_lost"
  | "no_token_savings";

export type CandidateGateResult =
  | { accepted: true; originalTokens: number; candidateTokens: number }
  | {
      accepted: false;
      reason: CandidateRejectionReason;
      originalTokens: number;
      candidateTokens: number;
      missingFacts?: string[];
    };

const PROTECTED_LINE_RE =
  /\b(?:error|failed|failure|fatal|critical|exception|warning|security|traceback)\b|\bFile\s+"[^"]+",\s+line\s+\d+|^\s*at\s+.*[\w./\\-]+:\d+(?::\d+)?\b/i;

function protectedJsonScalars(value: unknown, facts: string[]): void {
  if (typeof value === "string" && PROTECTED_LINE_RE.test(value)) {
    facts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => protectedJsonScalars(item, facts));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) =>
      protectedJsonScalars(item, facts),
    );
  }
}

export function extractProtectedFacts(
  content: string,
  kind?: ContentKind,
): string[] {
  if (kind === "json") {
    try {
      const facts: string[] = [];
      protectedJsonScalars(JSON.parse(content) as unknown, facts);
      return facts;
    } catch {
      return [];
    }
  }
  if (kind === "code") {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line &&
          (/^(?:import\b|from\s+\S+\s+import\b|export\b|(?:public|private|protected|static|abstract|async|pub\s+)*\s*(?:function|class|interface|type|enum|namespace|def|fn|struct|trait|func)\b)/.test(
            line,
          ) ||
            PROTECTED_LINE_RE.test(line)),
      );
  }
  if (kind === "diff") {
    return content
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.startsWith("diff --git ") ||
          line.startsWith("diff --cc ") ||
          line.startsWith("diff --combined ") ||
          line.startsWith("--- ") ||
          line.startsWith("+++ ") ||
          line.startsWith("@@ ") ||
          (line.startsWith("+") && !line.startsWith("+++")) ||
          (line.startsWith("-") && !line.startsWith("---")),
      );
  }
  if (kind === "table") {
    const lines = content.split(/\r?\n/).filter((line) => line.trim());
    return lines.filter(
      (line, index) => index < 2 || PROTECTED_LINE_RE.test(line),
    );
  }
  if (kind === "html") {
    const facts: string[] = [];
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(content)?.[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (title) facts.push(title);
    for (const match of content.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      if (match[1]) facts.push(match[1]);
    }
    for (const match of content.matchAll(/>([^<>]+)</g)) {
      const text = match[1]?.replace(/\s+/g, " ").trim();
      if (text && PROTECTED_LINE_RE.test(text)) facts.push(text);
    }
    return [...new Set(facts)];
  }
  if (kind === "text") {
    return splitTextSegments(content).filter((segment) =>
      PROTECTED_LINE_RE.test(segment),
    );
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && PROTECTED_LINE_RE.test(line));
}

function hasValidStructure(candidate: string, kind: ContentKind): boolean {
  if (kind !== "json") {
    return true;
  }
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

export function gateCompressionCandidate(input: {
  original: string;
  candidate: string;
  kind: ContentKind;
  checkStructure?: boolean;
  checkProtectedFacts?: boolean;
  originalTokens?: number;
}): CandidateGateResult {
  const originalTokens = input.originalTokens ?? estimateTokens(input.original);
  const candidateTokens = estimateTokens(input.candidate);
  if (!input.candidate.trim()) {
    return {
      accepted: false,
      reason: "empty_candidate",
      originalTokens,
      candidateTokens,
    };
  }
  if (
    input.checkStructure !== false
    && !hasValidStructure(input.candidate, input.kind)
  ) {
    return {
      accepted: false,
      reason: "invalid_structure",
      originalTokens,
      candidateTokens,
    };
  }

  const missingFacts = (input.checkProtectedFacts === false
    ? []
    : extractProtectedFacts(input.original, input.kind)
  ).filter((fact) => !input.candidate.includes(fact));
  if (missingFacts.length > 0) {
    return {
      accepted: false,
      reason: "protected_fact_lost",
      originalTokens,
      candidateTokens,
      missingFacts,
    };
  }
  if (candidateTokens >= originalTokens) {
    return {
      accepted: false,
      reason: "no_token_savings",
      originalTokens,
      candidateTokens,
    };
  }
  return { accepted: true, originalTokens, candidateTokens };
}
