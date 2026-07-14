export const DEFAULT_CCR_MAX_ENTRIES = 10_000;
export const DEFAULT_CCR_RETRIEVE_MAX_CHARS = 12_000;

export type CCRDefaultRetrieveMode = "summary" | "head" | "tail" | "full";

export interface CCRRetrieveDefaults {
  mode: CCRDefaultRetrieveMode;
  maxChars?: number;
}
export type RequestedCCRStorage = "auto" | "memory" | "bun-sqlite";
export type ActiveCCRStorage = "memory" | "bun-sqlite";
export type CCRStorageFallbackReason = "unsupported_runtime";

export interface CCRStoreDiagnostics {
  requested: RequestedCCRStorage;
  active: ActiveCCRStorage;
  fallbackReason?: CCRStorageFallbackReason;
}
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface CCRStoreOptions {
  maxEntries?: number;
  busyTimeoutMs?: number;
}

export function resolveSQLiteBusyTimeoutMs(busyTimeoutMs?: number): number {
  const resolved = busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error("CCR busyTimeoutMs must be a non-negative safe integer");
  }
  return resolved;
}

export function resolveCCRMaxEntries(maxEntries?: number): number {
  const resolved = maxEntries ?? DEFAULT_CCR_MAX_ENTRIES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("CCR maxEntries must be a positive safe integer");
  }
  return resolved;
}

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
  retrieveDefaults?: CCRRetrieveDefaults;
  contentForHash?: (hash: string) => {
    compressedContent: string;
    compressedTokens: number;
  };
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
  retrieveDefaults?: CCRRetrieveDefaults;
}

export interface CCRStats {
  entryCount: number;
  totalOriginalTokens: number;
  totalCompressedTokens: number;
  totalTokensSaved: number;
  totalRetrievals: number;
}

export interface CCRStore {
  readonly diagnostics: CCRStoreDiagnostics;
  put(input: CCRPutInput): Promise<CCREntry>;
  peek?(hash: string, sessionID?: string): Promise<CCREntry | null>;
  get(hash: string, sessionID?: string): Promise<CCREntry | null>;
  deleteSession(sessionID: string): Promise<number>;
  close(): Promise<void>;
  stats(sessionID?: string): Promise<CCRStats>;
  pruneExpired(now?: number): Promise<number>;
}
