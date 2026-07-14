import type { ContentKind } from "../compressors/types.js";
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
}): CandidateGateResult {
  const originalTokens = estimateTokens(input.original);
  const candidateTokens = estimateTokens(input.candidate);
  if (!input.candidate.trim()) {
    return {
      accepted: false,
      reason: "empty_candidate",
      originalTokens,
      candidateTokens,
    };
  }
  if (!hasValidStructure(input.candidate, input.kind)) {
    return {
      accepted: false,
      reason: "invalid_structure",
      originalTokens,
      candidateTokens,
    };
  }

  const missingFacts = extractProtectedFacts(input.original, input.kind).filter(
    (fact) => !input.candidate.includes(fact),
  );
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
