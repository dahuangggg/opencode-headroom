import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { DebugLevel, DebugSink } from "./config.js";
import type { CompressionDebugInfo } from "./compressors/types.js";
import type { CompressionStrength, ToolPolicyAction } from "./policy.js";

export type DebugDecision = "skipped" | "compressed" | "unchanged" | "error";

export interface DebugTraceConfig {
  debug: boolean;
  debugLevel: DebugLevel;
  debugSink: DebugSink;
  debugPath: string;
}

export interface DebugTraceRecord extends CompressionDebugInfo {
  version: 2;
  time: string;
  sessionID: string;
  callID: string;
  tool: string;
  decision: DebugDecision;
  reason?: string;
  policy?: {
    ruleId: string;
    source: "user" | "compatibility" | "builtin" | "default";
    action: ToolPolicyAction;
    strength: CompressionStrength;
  };
  source?: {
    kind: "toolOutput" | "outputPath";
    path?: string;
    displayChars: number;
    originalChars: number;
    readError?: string;
  };
  threshold: {
    chars: number;
    tokens: number;
    maxOutputChars: number;
  };
  sizes: {
    originalChars: number;
    originalTokens: number;
    compressedChars?: number;
    compressedTokens?: number;
    tokensSaved?: number;
  };
}

export interface DebugFileWriteResult {
  enabled: boolean;
  path?: string;
  written?: boolean;
  error?: string;
}

function withoutTraceSelections(record: DebugTraceRecord): DebugTraceRecord {
  const compressor = record.compressor;
  if (!compressor || !("selections" in compressor)) {
    return record;
  }

  const { selections: _selections, ...summaryCompressor } = compressor;
  return {
    ...record,
    compressor: summaryCompressor,
  };
}

export function debugRecordForLevel(
  record: DebugTraceRecord,
  level: DebugLevel,
): DebugTraceRecord {
  return level === "trace" ? record : withoutTraceSelections(record);
}

export function shouldWriteDebugMetadata(config: DebugTraceConfig): boolean {
  return (
    config.debug &&
    (config.debugSink === "metadata" || config.debugSink === "both")
  );
}

export function shouldWriteDebugFile(config: DebugTraceConfig): boolean {
  return config.debug && (config.debugSink === "file" || config.debugSink === "both");
}

export function resolveDebugPath(path: string, worktree?: string): string {
  return isAbsolute(path) ? path : resolve(worktree || process.cwd(), path);
}

export async function appendDebugRecord(
  config: DebugTraceConfig,
  worktree: string | undefined,
  record: DebugTraceRecord,
): Promise<DebugFileWriteResult> {
  if (!shouldWriteDebugFile(config)) {
    return { enabled: false };
  }

  let path: string | undefined;
  try {
    path = resolveDebugPath(config.debugPath, worktree);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${JSON.stringify(debugRecordForLevel(record, config.debugLevel))}\n`,
      "utf8",
    );
    return { enabled: true, path, written: true };
  } catch (error) {
    return {
      enabled: true,
      path,
      written: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
