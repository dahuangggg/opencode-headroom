export type HeadroomEngine = "native";

export type StorageKind = "auto" | "memory" | "bun-sqlite";
export type DebugLevel = "summary" | "trace";
export type DebugSink = "metadata" | "file" | "both";

export interface HeadroomStorageConfig {
  kind: StorageKind;
  path: string;
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
}

export const DEFAULT_HEADROOM_CONFIG: NormalizedHeadroomConfig = {
  engine: "native",
  thresholdTokens: 2000,
  thresholdChars: 8000,
  ttlHours: 24,
  storage: {
    kind: "auto",
    path: ".headroom/ccr.sqlite",
  },
  skipTools: ["headroom_*", "ctx_*"],
  maxOutputChars: 250000,
  debug: false,
  debugLevel: "summary",
  debugSink: "metadata",
  debugPath: ".headroom/debug.ndjson",
};

export function normalizeConfig(
  options: HeadroomPluginOptions = {},
): NormalizedHeadroomConfig {
  if (options.engine !== undefined && options.engine !== "native") {
    throw new Error(`Unsupported engine: ${String(options.engine)}`);
  }

  return {
    engine: options.engine ?? DEFAULT_HEADROOM_CONFIG.engine,
    thresholdTokens:
      options.thresholdTokens ?? DEFAULT_HEADROOM_CONFIG.thresholdTokens,
    thresholdChars: options.thresholdChars ?? DEFAULT_HEADROOM_CONFIG.thresholdChars,
    ttlHours: options.ttlHours ?? DEFAULT_HEADROOM_CONFIG.ttlHours,
    storage: {
      kind: options.storage?.kind ?? DEFAULT_HEADROOM_CONFIG.storage.kind,
      path: options.storage?.path ?? DEFAULT_HEADROOM_CONFIG.storage.path,
    },
    skipTools: options.skipTools
      ? [...options.skipTools]
      : [...DEFAULT_HEADROOM_CONFIG.skipTools],
    maxOutputChars: options.maxOutputChars ?? DEFAULT_HEADROOM_CONFIG.maxOutputChars,
    debug: options.debug ?? DEFAULT_HEADROOM_CONFIG.debug,
    debugLevel: options.debugLevel ?? DEFAULT_HEADROOM_CONFIG.debugLevel,
    debugSink: options.debugSink ?? DEFAULT_HEADROOM_CONFIG.debugSink,
    debugPath: options.debugPath ?? DEFAULT_HEADROOM_CONFIG.debugPath,
  };
}

export function shouldSkipTool(
  toolName: string,
  config: Pick<NormalizedHeadroomConfig, "skipTools">,
): boolean {
  return config.skipTools.some((pattern) => {
    if (pattern.endsWith("*")) {
      return toolName.startsWith(pattern.slice(0, -1));
    }

    return toolName === pattern;
  });
}
