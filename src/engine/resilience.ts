import {
  compressionProfileForStrength,
  type CompressionProfile,
} from "../compressors/profile.js";
import type { CompressionStrength } from "../policy.js";
import { createContentDigest } from "../store/ccr.js";

const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_RENDERED_HASH_CHARS = 128;
const CACHEABLE_STRATEGIES = new Set([
  "json",
  "search",
  "log",
  "text",
  "code",
  "diff",
  "table",
  "html",
]);
const CACHEABLE_SKIP_REASONS = new Set([
  "too_few_lines",
  "no_savings",
  "nothing_dropped",
  "invalid_syntax",
  "nothing_to_compress",
  "unsupported_language",
  "too_few_tokens",
  "over_compressed",
  "insufficient_savings",
  "too_few_segments",
  "invalid_diff",
  "too_few_matches",
  "invalid_json",
  "not_large_array",
  "mixed_no_savings",
  "mixed_passthrough",
  "candidate_empty_candidate",
  "candidate_invalid_structure",
  "candidate_protected_fact_lost",
  "candidate_no_token_savings",
]);

export interface CompressionDecisionCacheOptions {
  readonly maxEntries: number;
  readonly maxResultChars: number;
  readonly maxSingleResultChars: number;
  readonly ttlMs?: number;
  readonly clock?: () => number;
}

export interface CompressionResultInput {
  readonly output: string;
  readonly renderedHash: string;
  readonly strategy: string;
  readonly originalTokens: number;
  readonly compressedTokens: number;
}

export interface CompressionSkipInput {
  readonly strategy: string;
  readonly reason: string;
  readonly originalTokens: number;
}

export interface CachedCompressionResult extends CompressionResultInput {
  readonly kind: "result";
}

export interface CachedCompressionSkip extends CompressionSkipInput {
  readonly kind: "skip";
}

export type CachedCompressionDecision =
  | CachedCompressionResult
  | CachedCompressionSkip;

export interface CompressionDecisionKeyInput {
  readonly content: string;
  readonly query: string;
  readonly strength?: CompressionStrength;
  readonly profile?: CompressionProfile;
  readonly losslessThenLossy?: boolean;
  readonly knownOriginalTokens?: number;
}

export interface CompressionDecisionCacheStats {
  readonly entryCount: number;
  readonly resultEntryCount: number;
  readonly skipEntryCount: number;
  readonly resultChars: number;
}

interface StoredDecision {
  readonly value: CachedCompressionDecision;
  readonly expiresAt: number;
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function resolveClock(clock: (() => number) | undefined): () => number {
  if (clock !== undefined && typeof clock !== "function") {
    throw new Error("clock must be a function");
  }
  return clock ?? Date.now;
}

function validateStrategy(strategy: string): void {
  if (typeof strategy !== "string" || strategy.length === 0) {
    throw new Error("strategy must be a non-empty string");
  }
}

function isBoundedMetadata(value: string, maxChars: number): boolean {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxChars
  );
}

function isCacheableStrategy(strategy: string): boolean {
  return typeof strategy === "string" && CACHEABLE_STRATEGIES.has(strategy);
}

function isCacheableSkipReason(reason: string): boolean {
  return typeof reason === "string" && CACHEABLE_SKIP_REASONS.has(reason);
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJSON(entry)}`)
    .join(",")}}`;
}

/** Build a content-addressed identity for a deterministic compression choice. */
export function createCompressionDecisionKey(
  input: CompressionDecisionKeyInput,
): string {
  const strength = input.strength ?? "balanced";
  const profile = input.profile ?? compressionProfileForStrength(strength);
  if (
    input.knownOriginalTokens !== undefined &&
    (!Number.isSafeInteger(input.knownOriginalTokens) ||
      input.knownOriginalTokens < 0)
  ) {
    throw new Error(
      "knownOriginalTokens must be a non-negative safe integer when provided",
    );
  }

  const contentDigest = createContentDigest(input.content);
  const queryDigest = createContentDigest(input.query);
  const profileDigest = createContentDigest(
    canonicalJSON({ strength, profile }),
  );
  const lossless = input.losslessThenLossy === true ? "1" : "0";
  const knownTokens =
    input.knownOriginalTokens === undefined
      ? "unknown"
      : String(input.knownOriginalTokens);
  return [
    "compression-decision:v1",
    contentDigest,
    queryDigest,
    profileDigest,
    lossless,
    knownTokens,
  ].join(":");
}

/**
 * A bounded LRU for reusable compression decisions.
 *
 * Result and skip decisions share one eviction order and entry budget. Only
 * compressed result text counts against the character budget; skip decisions
 * are copied into a metadata-only representation.
 */
export class CompressionDecisionCache {
  private readonly entries = new Map<string, StoredDecision>();
  private readonly maxEntries: number;
  private readonly maxResultChars: number;
  private readonly maxSingleResultChars: number;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private retainedResultChars = 0;

  constructor(options: CompressionDecisionCacheOptions) {
    if (options === null || typeof options !== "object") {
      throw new Error("CompressionDecisionCache options are required");
    }

    this.maxEntries = positiveSafeInteger("maxEntries", options.maxEntries);
    this.maxResultChars = positiveSafeInteger(
      "maxResultChars",
      options.maxResultChars,
    );
    this.maxSingleResultChars = positiveSafeInteger(
      "maxSingleResultChars",
      options.maxSingleResultChars,
    );
    if (this.maxSingleResultChars > this.maxResultChars) {
      throw new Error(
        "maxSingleResultChars must not be greater than maxResultChars",
      );
    }
    this.ttlMs = positiveSafeInteger(
      "ttlMs",
      options.ttlMs ?? DEFAULT_CACHE_TTL_MS,
    );
    this.clock = resolveClock(options.clock);
  }

  get stats(): Readonly<CompressionDecisionCacheStats> {
    this.purgeExpired(this.now());
    let resultEntryCount = 0;
    let skipEntryCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.value.kind === "result") {
        resultEntryCount += 1;
      } else {
        skipEntryCount += 1;
      }
    }
    return Object.freeze({
      entryCount: this.entries.size,
      resultEntryCount,
      skipEntryCount,
      resultChars: this.retainedResultChars,
    });
  }

  get(key: string): CachedCompressionDecision | undefined {
    const now = this.now();
    const stored = this.entries.get(key);
    if (!stored) {
      return undefined;
    }
    if (stored.expiresAt <= now) {
      this.deleteEntry(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, stored);
    return stored.value;
  }

  putResult(key: string, input: CompressionResultInput): boolean {
    const now = this.now();
    this.purgeExpired(now);
    this.deleteEntry(key);

    if (
      input.output.length > this.maxSingleResultChars ||
      !isCacheableStrategy(input.strategy) ||
      !isBoundedMetadata(input.renderedHash, MAX_RENDERED_HASH_CHARS) ||
      !Number.isSafeInteger(input.originalTokens) ||
      input.originalTokens < 0 ||
      !Number.isSafeInteger(input.compressedTokens) ||
      input.compressedTokens < 0 ||
      input.compressedTokens >= input.originalTokens
    ) {
      return false;
    }

    const value = Object.freeze({
      kind: "result" as const,
      output: input.output,
      renderedHash: input.renderedHash,
      strategy: input.strategy,
      originalTokens: input.originalTokens,
      compressedTokens: input.compressedTokens,
    });
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    this.retainedResultChars += input.output.length;
    this.enforceBounds();
    return this.entries.has(key);
  }

  putSkip(key: string, input: CompressionSkipInput): boolean {
    const now = this.now();
    this.purgeExpired(now);
    this.deleteEntry(key);

    if (
      !isCacheableStrategy(input.strategy) ||
      !isCacheableSkipReason(input.reason) ||
      !Number.isSafeInteger(input.originalTokens) ||
      input.originalTokens < 0
    ) {
      return false;
    }

    // Copy only the permitted metadata fields. This intentionally strips any
    // raw/output properties supplied by an untyped JavaScript caller.
    const value = Object.freeze({
      kind: "skip" as const,
      strategy: input.strategy,
      reason: input.reason,
      originalTokens: input.originalTokens,
    });
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    this.enforceBounds();
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
    this.retainedResultChars = 0;
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) {
      throw new Error("clock must return a finite number");
    }
    return now;
  }

  private purgeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.deleteEntry(key);
      }
    }
  }

  private enforceBounds(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.retainedResultChars > this.maxResultChars
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.deleteEntry(oldestKey);
    }
  }

  private deleteEntry(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) {
      return;
    }
    if (existing.value.kind === "result") {
      this.retainedResultChars -= existing.value.output.length;
    }
    this.entries.delete(key);
  }
}

export interface StrategyCircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly clock?: () => number;
}

interface StrategyCircuitState {
  failures: number;
  openedAt?: number;
  halfOpen: boolean;
}

/** A small, per-strategy consecutive-failure circuit breaker. */
export class StrategyCircuitBreaker {
  private readonly states = new Map<string, StrategyCircuitState>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;

  constructor(options: StrategyCircuitBreakerOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new Error("StrategyCircuitBreaker options must be an object");
    }
    this.failureThreshold = nonNegativeSafeInteger(
      "failureThreshold",
      options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
    );
    this.cooldownMs = positiveSafeInteger(
      "cooldownMs",
      options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    );
    this.clock = resolveClock(options.clock);
  }

  isOpen(strategy: string): boolean {
    validateStrategy(strategy);
    if (this.failureThreshold === 0) {
      return false;
    }

    const state = this.states.get(strategy);
    if (!state) {
      return false;
    }
    if (state.halfOpen) {
      return true;
    }
    if (state.openedAt === undefined) {
      return false;
    }

    const now = this.now();
    if (now - state.openedAt < this.cooldownMs) {
      return true;
    }

    state.openedAt = undefined;
    state.halfOpen = true;
    return false;
  }

  recordFailure(strategy: string): void {
    validateStrategy(strategy);
    if (this.failureThreshold === 0) {
      return;
    }

    const now = this.now();
    const state = this.states.get(strategy) ?? {
      failures: 0,
      halfOpen: false,
    };

    if (state.openedAt !== undefined) {
      if (now - state.openedAt < this.cooldownMs) {
        return;
      }
      state.openedAt = undefined;
      state.halfOpen = true;
    }

    if (state.halfOpen) {
      state.failures = this.failureThreshold;
      state.openedAt = now;
      state.halfOpen = false;
      this.states.set(strategy, state);
      return;
    }

    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.openedAt = now;
    }
    this.states.set(strategy, state);
  }

  recordSuccess(strategy: string): void {
    validateStrategy(strategy);
    this.states.delete(strategy);
  }

  clear(): void {
    this.states.clear();
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) {
      throw new Error("clock must return a finite number");
    }
    return now;
  }
}
