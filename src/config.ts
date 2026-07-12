import {
  compileToolPattern,
  normalizeToolPolicy,
  type NormalizedToolPolicy,
  type ToolPolicyConfig,
} from "./policy.js";
import {
  normalizeOutputFilesConfig,
  type NormalizedOutputFilesConfig,
  type OutputFilesConfig,
} from "./source/output-file.js";
import {
  DEFAULT_CCR_MAX_ENTRIES,
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
} from "./store/types.js";

export type HeadroomEngine = "native";

export type StorageKind = "auto" | "memory" | "bun-sqlite";
export type DebugLevel = "summary" | "trace";
export type DebugSink = "metadata" | "file" | "both";

export interface HeadroomStorageConfig {
  kind: StorageKind;
  path: string;
  maxEntries: number;
  busyTimeoutMs: number;
}

export interface HeadroomPluginOptions {
  engine?: HeadroomEngine;
  thresholdTokens?: number;
  thresholdChars?: number;
  ttlHours?: number;
  storage?: Partial<HeadroomStorageConfig>;
  skipTools?: string[];
  maxOutputChars?: number;
  debug?: boolean;
  debugLevel?: DebugLevel;
  debugSink?: DebugSink;
  debugPath?: string;
  toolPolicy?: ToolPolicyConfig;
  outputFiles?: OutputFilesConfig;
}

export interface NormalizedHeadroomConfig {
  engine: HeadroomEngine;
  thresholdTokens: number;
  thresholdChars: number;
  ttlHours: number;
  storage: HeadroomStorageConfig;
  skipTools: string[];
  maxOutputChars: number;
  debug: boolean;
  debugLevel: DebugLevel;
  debugSink: DebugSink;
  debugPath: string;
  toolPolicy: NormalizedToolPolicy;
  outputFiles: NormalizedOutputFilesConfig;
}

export const DEFAULT_HEADROOM_CONFIG: NormalizedHeadroomConfig = {
  engine: "native",
  thresholdTokens: 2000,
  thresholdChars: 8000,
  ttlHours: 24,
  storage: {
    kind: "auto",
    path: ".headroom/ccr.sqlite",
    maxEntries: DEFAULT_CCR_MAX_ENTRIES,
    busyTimeoutMs: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  },
  skipTools: ["headroom_*", "ctx_*"],
  maxOutputChars: 250000,
  debug: false,
  debugLevel: "summary",
  debugSink: "metadata",
  debugPath: ".headroom/debug.ndjson",
  toolPolicy: normalizeToolPolicy(undefined, ["headroom_*", "ctx_*"]),
  outputFiles: normalizeOutputFilesConfig(undefined),
};

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function assertEnum(
  value: string,
  allowed: readonly string[],
  label: string,
): void {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

export function normalizeConfig(
  options: HeadroomPluginOptions = {},
): NormalizedHeadroomConfig {
  if (options.engine !== undefined && options.engine !== "native") {
    throw new Error(`Unsupported engine: ${String(options.engine)}`);
  }
  if (
    options.storage !== undefined &&
    (!options.storage ||
      typeof options.storage !== "object" ||
      Array.isArray(options.storage))
  ) {
    throw new Error("storage must be an object");
  }
  if (options.skipTools !== undefined && !Array.isArray(options.skipTools)) {
    throw new Error("skipTools must be an array");
  }
  if (options.debug !== undefined && typeof options.debug !== "boolean") {
    throw new Error("debug must be a boolean");
  }

  const skipTools = options.skipTools
    ? [...options.skipTools]
    : [...DEFAULT_HEADROOM_CONFIG.skipTools];

  const thresholdTokens =
    options.thresholdTokens ?? DEFAULT_HEADROOM_CONFIG.thresholdTokens;
  const thresholdChars =
    options.thresholdChars ?? DEFAULT_HEADROOM_CONFIG.thresholdChars;
  const ttlHours = options.ttlHours ?? DEFAULT_HEADROOM_CONFIG.ttlHours;
  const maxOutputChars =
    options.maxOutputChars ?? DEFAULT_HEADROOM_CONFIG.maxOutputChars;
  const storage = {
    kind: options.storage?.kind ?? DEFAULT_HEADROOM_CONFIG.storage.kind,
    path: options.storage?.path ?? DEFAULT_HEADROOM_CONFIG.storage.path,
    maxEntries:
      options.storage?.maxEntries ?? DEFAULT_HEADROOM_CONFIG.storage.maxEntries,
    busyTimeoutMs:
      options.storage?.busyTimeoutMs ??
      DEFAULT_HEADROOM_CONFIG.storage.busyTimeoutMs,
  };
  const debugLevel = options.debugLevel ?? DEFAULT_HEADROOM_CONFIG.debugLevel;
  const debugSink = options.debugSink ?? DEFAULT_HEADROOM_CONFIG.debugSink;
  const debugPath = options.debugPath ?? DEFAULT_HEADROOM_CONFIG.debugPath;

  assertPositiveFinite(thresholdTokens, "thresholdTokens");
  assertPositiveFinite(thresholdChars, "thresholdChars");
  assertPositiveFinite(ttlHours, "ttlHours");
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars <= 0) {
    throw new Error("maxOutputChars must be a positive safe integer");
  }
  assertEnum(storage.kind, ["auto", "memory", "bun-sqlite"], "storage.kind");
  if (typeof storage.path !== "string" || !storage.path.trim()) {
    throw new Error("storage.path must be a non-empty string");
  }
  if (!Number.isSafeInteger(storage.maxEntries) || storage.maxEntries <= 0) {
    throw new Error("storage.maxEntries must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(storage.busyTimeoutMs) ||
    storage.busyTimeoutMs < 0
  ) {
    throw new Error("storage.busyTimeoutMs must be a non-negative safe integer");
  }
  assertEnum(debugLevel, ["summary", "trace"], "debugLevel");
  assertEnum(debugSink, ["metadata", "file", "both"], "debugSink");
  if (typeof debugPath !== "string" || !debugPath.trim()) {
    throw new Error("debugPath must be a non-empty string");
  }

  return {
    engine: options.engine ?? DEFAULT_HEADROOM_CONFIG.engine,
    thresholdTokens,
    thresholdChars,
    ttlHours,
    storage,
    skipTools,
    maxOutputChars,
    debug: options.debug ?? DEFAULT_HEADROOM_CONFIG.debug,
    debugLevel,
    debugSink,
    debugPath,
    toolPolicy: normalizeToolPolicy(options.toolPolicy, skipTools),
    outputFiles: normalizeOutputFilesConfig(options.outputFiles),
  };
}

export function shouldSkipTool(
  toolName: string,
  config: Pick<NormalizedHeadroomConfig, "skipTools">,
): boolean {
  return config.skipTools.some((pattern) => compileToolPattern(pattern)(toolName));
}
