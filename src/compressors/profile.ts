import type { CompressionStrength } from "../policy.js";

export interface CompressionProfile {
  adaptive?: {
    bias: number;
  };
  json: {
    maxItems: number;
    maxObjectFields: number;
  };
  search: {
    maxFiles: number;
    matchesPerFile: number;
    maxMatches: number;
  };
  table?: {
    maxRows: number;
  };
  log: {
    maxErrors: number;
    maxStackTraces: number;
    stackTraceMaxLines: number;
    maxWarnings: number;
    maxTotalLines: number;
    contextLines: number;
  };
  text: {
    targetRatio: number;
  };
}

const PROFILES: Record<CompressionStrength, CompressionProfile> = {
  conservative: {
    adaptive: { bias: 1.5 },
    json: { maxItems: 24, maxObjectFields: 24 },
    search: { maxFiles: 25, matchesPerFile: 7, maxMatches: 50 },
    table: { maxRows: 24 },
    log: {
      maxErrors: 16,
      maxStackTraces: 5,
      stackTraceMaxLines: 24,
      maxWarnings: 10,
      maxTotalLines: 160,
      contextLines: 4,
    },
    text: { targetRatio: 0.7 },
  },
  balanced: {
    adaptive: { bias: 1 },
    json: { maxItems: 13, maxObjectFields: 13 },
    search: { maxFiles: 15, matchesPerFile: 5, maxMatches: 30 },
    table: { maxRows: 13 },
    log: {
      maxErrors: 10,
      maxStackTraces: 3,
      stackTraceMaxLines: 20,
      maxWarnings: 5,
      maxTotalLines: 100,
      contextLines: 3,
    },
    text: { targetRatio: 0.5 },
  },
  aggressive: {
    adaptive: { bias: 0.7 },
    json: { maxItems: 8, maxObjectFields: 8 },
    search: { maxFiles: 10, matchesPerFile: 3, maxMatches: 20 },
    table: { maxRows: 8 },
    log: {
      maxErrors: 6,
      maxStackTraces: 2,
      stackTraceMaxLines: 14,
      maxWarnings: 3,
      maxTotalLines: 60,
      contextLines: 2,
    },
    text: { targetRatio: 0.3 },
  },
};

export function compressionProfileForStrength(
  strength: CompressionStrength = "balanced",
): CompressionProfile {
  return PROFILES[strength];
}
