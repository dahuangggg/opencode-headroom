export interface CCRPutInput {
  sessionID: string;
  callID?: string;
  tool?: string;
  strategy: string;
  originalContent: string;
  compressedContent: string;
  originalTokens: number;
  compressedTokens: number;
  ttlMs: number;
}

export interface CCREntry {
  hash: string;
  sessionID: string;
  callID?: string;
  tool?: string;
  strategy: string;
  originalContent: string;
  compressedContent: string;
  originalTokens: number;
  compressedTokens: number;
  originalChars: number;
  compressedChars: number;
  createdAt: number;
  expiresAt: number;
  retrievalCount: number;
}

export interface CCRStats {
  entryCount: number;
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  totalTokensSaved: number;
  totalRetrievals: number;
}

export interface CCRStore {
  put(input: CCRPutInput): Promise<CCREntry>;
  get(hash: string): Promise<CCREntry | null>;
  stats(sessionID?: string): Promise<CCRStats>;
  pruneExpired(now?: number): Promise<number>;
}
