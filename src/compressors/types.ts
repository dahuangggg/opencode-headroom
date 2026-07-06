export type ContentKind = "json" | "search" | "log" | "text" | "diff";

export interface DetectionResult {
  kind: ContentKind;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface CompressorInput {
  content: string;
  hash: string;
  query: string;
}

export interface CompressorResult {
  changed: boolean;
  output: string;
  strategy: ContentKind;
  reason?: string;
}
