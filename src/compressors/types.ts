export type ContentKind =
  | "json"
  | "search"
  | "log"
  | "text"
  | "code"
  | "diff"
  | "table";

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
}
import type { CompressionProfile } from "./profile.js";
