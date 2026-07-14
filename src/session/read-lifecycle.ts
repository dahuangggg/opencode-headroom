import { resolve } from "node:path";

import { containsCCRMarker } from "../markers.js";
import { createContentDigest } from "../store/ccr.js";
import type { CCRStore } from "../store/types.js";
import { estimateTokens } from "../token.js";

export interface ReadLifecycleOptions {
  basePath: string;
  ttlMs: number;
  maxReplacements?: number;
  maxOperations?: number;
}

export interface ReadLifecycleStats {
  readsTotal: number;
  readsStale: number;
  readsSuperseded: number;
  replacementsApplied: number;
  frozenReadsSkipped: number;
  bytesSaved: number;
  operationsOverflowed: boolean;
}

interface CompletedToolStateLike {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  metadata?: unknown;
}

interface ToolPartLike {
  tool: string;
  sessionID: string;
  callID?: string;
  metadata?: unknown;
  state: CompletedToolStateLike;
}

interface ReadRange {
  full: boolean;
  start: number;
  end: number;
}

interface FileOperation {
  kind: "read" | "write";
  messageIndex: number;
  pathKey: string;
  displayPath: string;
  sessionID: string;
  callID?: string;
  range?: ReadRange;
  part: ToolPartLike;
}

type ReadState = "fresh" | "stale" | "superseded";

interface CachedReplacement {
  hash: string;
  contentDigest: string;
}

const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasCacheControl(...values: unknown[]): boolean {
  return values.some((value) => {
    const metadata = record(value);
    return Boolean(metadata?.cache_control ?? metadata?.cacheControl);
  });
}

function completedToolPart(value: unknown): ToolPartLike | undefined {
  const candidate = record(value);
  const state = record(candidate?.state);
  if (
    candidate?.type !== "tool" ||
    typeof candidate.tool !== "string" ||
    typeof candidate.sessionID !== "string" ||
    state?.status !== "completed" ||
    typeof state.output !== "string"
  ) {
    return undefined;
  }
  const input = record(state.input);
  if (!input) return undefined;
  return {
    tool: candidate.tool,
    sessionID: candidate.sessionID,
    ...(typeof candidate.callID === "string"
      ? { callID: candidate.callID }
      : {}),
    metadata: candidate.metadata,
    state: state as unknown as CompletedToolStateLike,
  };
}

function filePathFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "file_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function readRange(input: Record<string, unknown>): ReadRange | undefined {
  const hasOffset = input.offset !== undefined;
  const hasLimit = input.limit !== undefined;
  if (!hasOffset && !hasLimit) {
    return { full: true, start: 0, end: Number.POSITIVE_INFINITY };
  }
  const offset = hasOffset ? nonNegativeInteger(input.offset) : 0;
  const limit = hasLimit ? nonNegativeInteger(input.limit) : undefined;
  if (offset === undefined || (hasLimit && (limit === undefined || limit === 0))) {
    return undefined;
  }
  return {
    full: false,
    start: offset,
    end: limit === undefined ? Number.POSITIVE_INFINITY : offset + limit,
  };
}

function rangeCovers(later: ReadRange | undefined, earlier: ReadRange | undefined): boolean {
  if (later?.full) return true;
  if (!later || !earlier || earlier.full) return false;
  return later.start <= earlier.start && later.end >= earlier.end;
}

function lifecycleMarker(
  path: string,
  state: Exclude<ReadState, "fresh">,
  hash: string,
): string {
  const displayPath = path
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029\[\]]/gu, "?")
    .slice(0, 256);
  const reason =
    state === "stale"
      ? "is stale after a later write"
      : "is superseded by a later Read";
  return `[Read of ${displayPath} ${reason}. Retrieve original: hash=${hash}]`;
}

function scanOperations(
  messages: readonly { parts: readonly unknown[] }[],
  basePath: string,
  maxOperations: number,
): {
  operations: FileOperation[];
  frozenThrough: number;
  overflowed: boolean;
} {
  const operations: FileOperation[] = [];
  let frozenThrough = -1;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!message) continue;
    for (const part of message.parts) {
      const candidate = record(part);
      const state = record(candidate?.state);
      if (hasCacheControl(candidate?.metadata, state?.metadata)) {
        frozenThrough = Math.max(frozenThrough, messageIndex);
      }

      const toolPart = completedToolPart(part);
      if (!toolPart) continue;
      const tool = toolPart.tool.toLowerCase();
      const kind = READ_TOOLS.has(tool)
        ? "read"
        : WRITE_TOOLS.has(tool)
          ? "write"
          : undefined;
      const displayPath = filePathFromInput(toolPart.state.input);
      if (!kind || !displayPath) continue;
      operations.push({
        kind,
        messageIndex,
        pathKey: `${toolPart.sessionID}\0${resolve(basePath, displayPath)}`,
        displayPath,
        sessionID: toolPart.sessionID,
        callID: toolPart.callID,
        ...(kind === "read" ? { range: readRange(toolPart.state.input) } : {}),
        part: toolPart,
      });
      if (operations.length > maxOperations) {
        return { operations: [], frozenThrough, overflowed: true };
      }
    }
  }

  return { operations, frozenThrough, overflowed: false };
}

function classifyReads(
  operations: readonly FileOperation[],
): Map<FileOperation, ReadState> {
  const states = new Map<FileOperation, ReadState>();
  const futureByPath = new Map<
    string,
    { hasWrite: boolean; readRanges: Array<ReadRange | undefined> }
  >();

  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (!operation) continue;
    const future = futureByPath.get(operation.pathKey) ?? {
      hasWrite: false,
      readRanges: [],
    };
    if (operation.kind === "write") {
      future.hasWrite = true;
    } else {
      let state: ReadState = "fresh";
      if (future.hasWrite) {
        state = "stale";
      } else if (
        future.readRanges.some((range) =>
          rangeCovers(range, operation.range),
        )
      ) {
        state = "superseded";
      }
      states.set(operation, state);
      future.readRanges.push(operation.range);
    }
    futureByPath.set(operation.pathKey, future);
  }
  return states;
}

export class ReadLifecycleManager {
  private readonly options: Required<ReadLifecycleOptions>;
  private readonly replacements = new Map<string, CachedReplacement>();

  constructor(
    private readonly store: CCRStore,
    options: ReadLifecycleOptions,
  ) {
    if (!options.basePath.trim()) {
      throw new Error("Read lifecycle basePath must be non-empty");
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("Read lifecycle ttlMs must be positive");
    }
    const maxReplacements = options.maxReplacements ?? 10_000;
    if (!Number.isSafeInteger(maxReplacements) || maxReplacements <= 0) {
      throw new Error("Read lifecycle maxReplacements must be a positive safe integer");
    }
    const maxOperations = options.maxOperations ?? 10_000;
    if (!Number.isSafeInteger(maxOperations) || maxOperations <= 0) {
      throw new Error("Read lifecycle maxOperations must be a positive safe integer");
    }
    this.options = { ...options, maxReplacements, maxOperations };
  }

  get replacementCount(): number {
    return this.replacements.size;
  }

  deleteSession(sessionID: string): void {
    const prefix = `${sessionID}\0`;
    for (const key of this.replacements.keys()) {
      if (key.startsWith(prefix)) this.replacements.delete(key);
    }
  }

  clear(): void {
    this.replacements.clear();
  }

  private remember(key: string, replacement: CachedReplacement): void {
    this.replacements.delete(key);
    this.replacements.set(key, replacement);
    while (this.replacements.size > this.options.maxReplacements) {
      const oldest = this.replacements.keys().next().value;
      if (oldest === undefined) break;
      this.replacements.delete(oldest);
    }
  }

  private async replace(
    operation: FileOperation,
    state: Exclude<ReadState, "fresh">,
    original: string,
  ): Promise<string | undefined> {
    if (!operation.callID) return undefined;
    const key = `${operation.sessionID}\0${operation.callID}`;
    const contentDigest = createContentDigest(original);
    const cached = this.replacements.get(key);
    if (cached?.contentDigest === contentDigest) {
      if (this.store.peek) {
        const active = await this.store.peek(cached.hash, operation.sessionID);
        if (active && createContentDigest(active.originalContent) === contentDigest) {
          this.remember(key, cached);
          return lifecycleMarker(operation.displayPath, state, cached.hash);
        }
      }
      this.replacements.delete(key);
    }

    const candidate = lifecycleMarker(
      operation.displayPath,
      state,
      "0".repeat(24),
    );
    const originalTokens = estimateTokens(original);
    const compressedTokens = estimateTokens(candidate);
    const entry = await this.store.put({
      sessionID: operation.sessionID,
      callID: operation.callID,
      tool: operation.part.tool,
      strategy: `read_lifecycle_${state}`,
      originalContent: original,
      compressedContent: candidate,
      originalTokens,
      compressedTokens,
      ttlMs: this.options.ttlMs,
      retrieveDefaults: { mode: "summary", maxChars: 12_000 },
      contentForHash: (hash) => {
        const output = lifecycleMarker(operation.displayPath, state, hash);
        return {
          compressedContent: output,
          compressedTokens: estimateTokens(output),
        };
      },
    });
    this.remember(key, { hash: entry.hash, contentDigest });
    return entry.compressedContent;
  }

  async apply(
    messages: readonly { parts: readonly unknown[] }[],
  ): Promise<ReadLifecycleStats> {
    const stats: ReadLifecycleStats = {
      readsTotal: 0,
      readsStale: 0,
      readsSuperseded: 0,
      replacementsApplied: 0,
      frozenReadsSkipped: 0,
      bytesSaved: 0,
      operationsOverflowed: false,
    };
    const { operations, frozenThrough, overflowed } = scanOperations(
      messages,
      this.options.basePath,
      this.options.maxOperations,
    );
    if (overflowed) {
      stats.operationsOverflowed = true;
      return stats;
    }
    const states = classifyReads(operations);

    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (!operation || operation.kind !== "read") continue;
      stats.readsTotal += 1;
      const state = states.get(operation) ?? "fresh";
      if (state === "fresh") continue;
      if (state === "stale") stats.readsStale += 1;
      else stats.readsSuperseded += 1;

      if (operation.messageIndex <= frozenThrough) {
        stats.frozenReadsSkipped += 1;
        continue;
      }

      const original = operation.part.state.output;
      if (!original.trim() || containsCCRMarker(original)) continue;
      const candidate = lifecycleMarker(
        operation.displayPath,
        state,
        "0".repeat(24),
      );
      if (estimateTokens(candidate) >= estimateTokens(original)) continue;

      try {
        const replacement = await this.replace(operation, state, original);
        if (!replacement) continue;
        operation.part.state.output = replacement;
        stats.replacementsApplied += 1;
        stats.bytesSaved += Math.max(0, original.length - replacement.length);
      } catch {
        // A lifecycle storage failure must leave the original message intact.
      }
    }

    return stats;
  }
}
