export type RequestedTelemetryAdapter = "auto" | "memory" | "bun-sqlite";
export type ActiveTelemetryAdapter = "memory" | "bun-sqlite";
export type TelemetryFallbackReason =
  | "adapter_unavailable"
  | "initialization_failed"
  | "unsupported_runtime"
  | "unknown";
export type CompressionTelemetryOutcome = "compressed" | "skipped" | "error";
export type RetrievalTelemetryMode =
  | "full"
  | "query"
  | "range"
  | "head"
  | "tail"
  | "summary";
export type RetrievalTelemetryOutcome = "hit" | "miss";
export type CompressionTelemetryReason =
  | "compressed"
  | "below_threshold"
  | "skip_tool"
  | "legacy_skip_tool"
  | "builtin_preserve"
  | "default_preserve"
  | "user_preserve"
  | "too_large"
  | "empty_or_marked"
  | "code_passthrough"
  | "diff_passthrough"
  | "too_few_lines"
  | "too_few_segments"
  | "too_few_matches"
  | "invalid_json"
  | "not_large_array"
  | "nothing_dropped"
  | "no_savings"
  | "mixed_no_savings"
  | "mixed_passthrough"
  | "source_denied"
  | "hook_error"
  | "engine_error"
  | "unknown";

export interface LocalTelemetryOptions {
  requestedAdapter: RequestedTelemetryAdapter;
  activeAdapter: ActiveTelemetryAdapter;
  fallbackReason?: TelemetryFallbackReason;
}

export interface AdapterTelemetrySnapshot {
  requested: RequestedTelemetryAdapter;
  active: ActiveTelemetryAdapter;
  fallbackReason?: TelemetryFallbackReason;
}

export interface CompressionTelemetryInput {
  sessionID: string;
  outcome: CompressionTelemetryOutcome;
  reason: CompressionTelemetryReason;
  estimatedTokensSaved: number;
  latencyMs: number;
}

export interface LatencyTelemetrySnapshot {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface RetrievalTelemetryInput {
  sessionID: string;
  mode: RetrievalTelemetryMode;
  outcome: RetrievalTelemetryOutcome;
  outputTokens: number;
  latencyMs: number;
}

export interface LocalTelemetrySnapshot {
  adapter: AdapterTelemetrySnapshot;
  compressed: number;
  skipped: number;
  error: number;
  reasonDistribution: Partial<Record<CompressionTelemetryReason, number>>;
  grossEstimatedSavings: number;
  retrievalCount: number;
  retrievalTokensByMode: Record<RetrievalTelemetryMode, number>;
  misses: number;
  fullRetrieveRate: number;
  estimatedNetSavings: number;
  latency: LatencyTelemetrySnapshot;
}

const REQUESTED_ADAPTERS = ["auto", "memory", "bun-sqlite"] as const;
const ACTIVE_ADAPTERS = ["memory", "bun-sqlite"] as const;
const FALLBACK_REASONS = [
  "adapter_unavailable",
  "initialization_failed",
  "unsupported_runtime",
  "unknown",
] as const;
const COMPRESSION_OUTCOMES = ["compressed", "skipped", "error"] as const;
const RETRIEVAL_MODES = [
  "full",
  "query",
  "range",
  "head",
  "tail",
  "summary",
] as const;
const RETRIEVAL_OUTCOMES = ["hit", "miss"] as const;
const COMPRESSION_REASONS = [
  "compressed",
  "below_threshold",
  "skip_tool",
  "legacy_skip_tool",
  "builtin_preserve",
  "default_preserve",
  "user_preserve",
  "too_large",
  "empty_or_marked",
  "code_passthrough",
  "diff_passthrough",
  "too_few_lines",
  "too_few_segments",
  "too_few_matches",
  "invalid_json",
  "not_large_array",
  "nothing_dropped",
  "no_savings",
  "mixed_no_savings",
  "mixed_passthrough",
  "source_denied",
  "hook_error",
  "engine_error",
  "unknown",
] as const;

interface TelemetryBucket {
  compressed: number;
  skipped: number;
  error: number;
  reasons: Map<CompressionTelemetryReason, number>;
  grossEstimatedSavings: number;
  retrievalCount: number;
  retrievalTokensByMode: Record<RetrievalTelemetryMode, number>;
  misses: number;
  fullRetrievals: number;
  latency: LatencyTelemetrySnapshot;
}

function emptyRetrievalTokens(): Record<RetrievalTelemetryMode, number> {
  return {
    full: 0,
    query: 0,
    range: 0,
    head: 0,
    tail: 0,
    summary: 0,
  };
}

function createBucket(): TelemetryBucket {
  return {
    compressed: 0,
    skipped: 0,
    error: 0,
    reasons: new Map(),
    grossEstimatedSavings: 0,
    retrievalCount: 0,
    retrievalTokensByMode: emptyRetrievalTokens(),
    misses: 0,
    fullRetrievals: 0,
    latency: { count: 0, totalMs: 0, maxMs: 0 },
  };
}

function assertEnum(
  value: string,
  allowed: readonly string[],
  label: string,
): void {
  if (!allowed.includes(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
}

function assertSessionID(sessionID: string): void {
  if (!sessionID.trim()) {
    throw new Error("sessionID must be a non-empty string");
  }
}

function recordLatency(bucket: TelemetryBucket, latencyMs: number): void {
  bucket.latency.count += 1;
  bucket.latency.totalMs += latencyMs;
  bucket.latency.maxMs = Math.max(bucket.latency.maxMs, latencyMs);
}

function reasonSnapshot(
  reasons: ReadonlyMap<CompressionTelemetryReason, number>,
): Partial<Record<CompressionTelemetryReason, number>> {
  return Object.fromEntries(
    [...reasons.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function totalRetrievalTokens(bucket: TelemetryBucket): number {
  return RETRIEVAL_MODES.reduce(
    (total, mode) => total + bucket.retrievalTokensByMode[mode],
    0,
  );
}

export class LocalTelemetryAggregator {
  private readonly adapter: AdapterTelemetrySnapshot;
  private readonly global = createBucket();
  private readonly sessions = new Map<string, TelemetryBucket>();

  constructor(options: LocalTelemetryOptions) {
    assertEnum(options.requestedAdapter, REQUESTED_ADAPTERS, "requested adapter");
    assertEnum(options.activeAdapter, ACTIVE_ADAPTERS, "active adapter");
    if (options.fallbackReason !== undefined) {
      assertEnum(options.fallbackReason, FALLBACK_REASONS, "fallback reason");
    }
    this.adapter = {
      requested: options.requestedAdapter,
      active: options.activeAdapter,
      ...(options.fallbackReason
        ? { fallbackReason: options.fallbackReason }
        : {}),
    };
  }

  private bucketsFor(sessionID: string): TelemetryBucket[] {
    let session = this.sessions.get(sessionID);
    if (!session) {
      session = createBucket();
      this.sessions.set(sessionID, session);
    }
    return [this.global, session];
  }

  recordCompression(input: CompressionTelemetryInput): void {
    assertSessionID(input.sessionID);
    assertEnum(input.outcome, COMPRESSION_OUTCOMES, "compression outcome");
    assertEnum(input.reason, COMPRESSION_REASONS, "compression reason");
    assertNonNegativeFinite(
      input.estimatedTokensSaved,
      "estimatedTokensSaved",
    );
    assertNonNegativeFinite(input.latencyMs, "latencyMs");

    for (const bucket of this.bucketsFor(input.sessionID)) {
      bucket[input.outcome] += 1;
      bucket.reasons.set(
        input.reason,
        (bucket.reasons.get(input.reason) ?? 0) + 1,
      );
      if (input.outcome === "compressed") {
        bucket.grossEstimatedSavings += input.estimatedTokensSaved;
      }
      recordLatency(bucket, input.latencyMs);
    }
  }

  recordRetrieval(input: RetrievalTelemetryInput): void {
    assertSessionID(input.sessionID);
    assertEnum(input.mode, RETRIEVAL_MODES, "retrieval mode");
    assertEnum(input.outcome, RETRIEVAL_OUTCOMES, "retrieval outcome");
    assertNonNegativeFinite(input.outputTokens, "outputTokens");
    assertNonNegativeFinite(input.latencyMs, "latencyMs");

    for (const bucket of this.bucketsFor(input.sessionID)) {
      bucket.retrievalCount += 1;
      bucket.retrievalTokensByMode[input.mode] += input.outputTokens;
      if (input.outcome === "miss") {
        bucket.misses += 1;
      }
      if (input.mode === "full") {
        bucket.fullRetrievals += 1;
      }
      recordLatency(bucket, input.latencyMs);
    }
  }

  deleteSession(sessionID: string): void {
    assertSessionID(sessionID);
    this.sessions.delete(sessionID);
  }

  snapshot(sessionID?: string): LocalTelemetrySnapshot {
    const bucket =
      sessionID === undefined
        ? this.global
        : (this.sessions.get(sessionID) ?? createBucket());
    return {
      adapter: { ...this.adapter },
      compressed: bucket.compressed,
      skipped: bucket.skipped,
      error: bucket.error,
      reasonDistribution: reasonSnapshot(bucket.reasons),
      grossEstimatedSavings: bucket.grossEstimatedSavings,
      retrievalCount: bucket.retrievalCount,
      retrievalTokensByMode: { ...bucket.retrievalTokensByMode },
      misses: bucket.misses,
      fullRetrieveRate:
        bucket.retrievalCount === 0
          ? 0
          : bucket.fullRetrievals / bucket.retrievalCount,
      estimatedNetSavings:
        bucket.grossEstimatedSavings - totalRetrievalTokens(bucket),
      latency: { ...bucket.latency },
    };
  }
}

export function renderTelemetrySnapshot(
  snapshot: LocalTelemetrySnapshot,
): string {
  const retrievalTokens = RETRIEVAL_MODES.map(
    (mode) => `${mode}=${snapshot.retrievalTokensByMode[mode]}`,
  ).join(", ");
  const reasons = Object.entries(snapshot.reasonDistribution)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
  return [
    `storage adapter: ${snapshot.adapter.requested} -> ${snapshot.adapter.active}`,
    ...(snapshot.adapter.fallbackReason
      ? [`storage fallback: ${snapshot.adapter.fallbackReason}`]
      : []),
    `compression outcomes: compressed=${snapshot.compressed}, skipped=${snapshot.skipped}, error=${snapshot.error}`,
    `compression reasons: ${reasons || "none"}`,
    `gross estimated savings: ${snapshot.grossEstimatedSavings}`,
    `retrievals: ${snapshot.retrievalCount}`,
    `retrieval tokens: ${retrievalTokens}`,
    `retrieval misses: ${snapshot.misses}`,
    `full retrieve rate: ${snapshot.fullRetrieveRate.toFixed(3)}`,
    `estimated net savings: ${snapshot.estimatedNetSavings}`,
    `latency ms: count=${snapshot.latency.count}, total=${snapshot.latency.totalMs.toFixed(3)}, max=${snapshot.latency.maxMs.toFixed(3)}`,
  ].join("\n");
}
