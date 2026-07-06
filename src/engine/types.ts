export interface ToolOutputCompressionInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
  output: string;
  ttlMs: number;
}

export interface ToolOutputCompressionResult {
  changed: boolean;
  output: string;
  strategy: string;
  hash?: string;
  originalTokens: number;
  compressedTokens: number;
  reason?: string;
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
  retrieve(hash: string, query?: string): Promise<RetrieveResult>;
  stats(sessionID?: string): Promise<StatsResult>;
}
