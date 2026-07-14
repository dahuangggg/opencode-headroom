import type { CompressionDebugInfo } from "../compressors/types.js";
import type { CompressionStrength } from "../policy.js";
import type { CCRRetrieveDefaults } from "../store/types.js";

export type RetrieveMode = "full" | "query" | "range" | "head" | "tail" | "summary";

export interface RetrieveOptions {
  mode?: RetrieveMode;
  query?: string;
  startLine?: number;
  endLine?: number;
  lines?: number;
  contextLines?: number;
  maxMatches?: number;
  maxChars?: number;
}

export type RetrieveRequest = string | RetrieveOptions;

export interface ToolOutputCompressionInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
  intent?: string;
  output: string;
  ttlMs: number;
  strength?: CompressionStrength;
  retrieveDefaults?: CCRRetrieveDefaults;
}

export interface ToolOutputCompressionResult {
  changed: boolean;
  output: string;
  strategy: string;
  hash?: string;
  originalTokens: number;
  compressedTokens: number;
  reason?: string;
  debug?: CompressionDebugInfo;
}

export interface RetrieveResult {
  found: boolean;
  output: string;
}

export interface StatsResult {
  output: string;
}

export interface CompressionEngine {
  name: string;
  compress(
    input: ToolOutputCompressionInput,
  ): Promise<ToolOutputCompressionResult>;
  retrieve(
    hash: string,
    request?: RetrieveRequest,
    sessionID?: string,
  ): Promise<RetrieveResult>;
  stats(sessionID?: string): Promise<StatsResult>;
}
