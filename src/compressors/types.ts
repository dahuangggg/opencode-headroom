export type ContentKind =
  | "json"
  | "search"
  | "log"
  | "text"
  | "code"
  | "diff"
  | "table"
  | "html";

export interface DetectionResult {
  kind: ContentKind;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface CompressorInput {
  content: string;
  hash: string;
  query: string;
  profile?: CompressionProfile;
  originalTokens?: number;
}

export interface CompressorDebugSummary {
  strategy: ContentKind;
  originalChars: number;
  compressedChars: number;
  kept: Record<string, unknown>;
  dropped: Record<string, unknown>;
  selections?: Array<Record<string, unknown>>;
}

export interface CompressionDebugInfo {
  router?: {
    kind: ContentKind;
    confidence: number;
    metadata: Record<string, unknown>;
  };
  compressor?: CompressorDebugSummary;
  lossless?: {
    applied: boolean;
    transform?: "runs" | "search_heading";
    originalChars: number;
    compactedChars: number;
  };
  ccr?: {
    hash?: string;
    stored: boolean;
  };
}

export interface CompressorResult {
  changed: boolean;
  output: string;
  strategy: ContentKind;
  reason?: string;
  debug?: CompressionDebugInfo;
  tokenCounts?: {
    original: number;
    compressed: number;
  };
}
import type { CompressionProfile } from "./profile.js";
