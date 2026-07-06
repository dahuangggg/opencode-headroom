import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { DebugLevel, DebugSink } from "./config.js";
import type { CompressionDebugInfo } from "./compressors/types.js";

export type DebugDecision = "skipped" | "compressed" | "unchanged" | "error";

export interface DebugTraceConfig {
  debug: boolean;
  debugLevel: DebugLevel;
  debugSink: DebugSink;
  debugPath: string;
}

export interface DebugTraceRecord extends CompressionDebugInfo {
  version: 1;
  time: string;
  sessionID: string;
  callID: string;
  tool: string;
  decision: DebugDecision;
  reason?: string;
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

export function resolveDebugPath(path: string, worktree: string): string {
  return isAbsolute(path) ? path : resolve(worktree, path);
}

export async function appendDebugRecord(
  config: DebugTraceConfig,
  worktree: string,
  record: DebugTraceRecord,
): Promise<void> {
  if (!shouldWriteDebugFile(config)) {
    return;
  }

  const path = resolveDebugPath(config.debugPath, worktree);
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${JSON.stringify(debugRecordForLevel(record, config.debugLevel))}\n`,
      "utf8",
    );
  } catch {
    // Debug output must never affect compression behavior.
  }
}
