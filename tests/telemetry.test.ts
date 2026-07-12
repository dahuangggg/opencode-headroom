import { describe, expect, it } from "vitest";

import { LocalTelemetryAggregator } from "../src/telemetry.js";

describe("local telemetry aggregator", () => {
  it("reports requested and active adapters with a bounded fallback reason", () => {
    const telemetry = new LocalTelemetryAggregator({
      requestedAdapter: "auto",
      activeAdapter: "memory",
      fallbackReason: "initialization_failed",
    });

    expect(telemetry.snapshot().adapter).toEqual({
      requested: "auto",
      active: "memory",
      fallbackReason: "initialization_failed",
    });
  });

  it("aggregates compression outcomes, reasons, savings, and latency", () => {
    const telemetry = new LocalTelemetryAggregator({
      requestedAdapter: "memory",
      activeAdapter: "memory",
    });
    telemetry.recordCompression({
      sessionID: "session-1",
      outcome: "compressed",
      reason: "compressed",
      estimatedTokensSaved: 120,
      latencyMs: 5,
    });
    telemetry.recordCompression({
      sessionID: "session-1",
      outcome: "skipped",
      reason: "below_threshold",
      estimatedTokensSaved: 0,
      latencyMs: 3,
    });
    telemetry.recordCompression({
      sessionID: "session-1",
      outcome: "error",
      reason: "hook_error",
      estimatedTokensSaved: 0,
      latencyMs: 7,
    });

    expect(telemetry.snapshot()).toMatchObject({
      compressed: 1,
      skipped: 1,
      error: 1,
      reasonDistribution: {
        below_threshold: 1,
        compressed: 1,
        hook_error: 1,
      },
      grossEstimatedSavings: 120,
      estimatedNetSavings: 120,
      latency: {
        count: 3,
        totalMs: 15,
        maxMs: 7,
      },
    });
  });

  it("subtracts every retrieve output and allows negative net savings", () => {
    const telemetry = new LocalTelemetryAggregator({
      requestedAdapter: "memory",
      activeAdapter: "memory",
    });
    telemetry.recordCompression({
      sessionID: "session-1",
      outcome: "compressed",
      reason: "compressed",
      estimatedTokensSaved: 100,
      latencyMs: 5,
    });
    telemetry.recordRetrieval({
      sessionID: "session-1",
      mode: "query",
      outcome: "hit",
      outputTokens: 20,
      latencyMs: 2,
    });
    telemetry.recordRetrieval({
      sessionID: "session-1",
      mode: "full",
      outcome: "hit",
      outputTokens: 150,
      latencyMs: 4,
    });
    telemetry.recordRetrieval({
      sessionID: "session-1",
      mode: "tail",
      outcome: "miss",
      outputTokens: 10,
      latencyMs: 1,
    });

    const snapshot = telemetry.snapshot();
    expect(snapshot).toMatchObject({
      retrievalCount: 3,
      retrievalTokensByMode: {
        full: 150,
        query: 20,
        tail: 10,
      },
      misses: 1,
      grossEstimatedSavings: 100,
      estimatedNetSavings: -80,
      latency: {
        count: 4,
        totalMs: 12,
        maxMs: 5,
      },
    });
    expect(snapshot.fullRetrieveRate).toBeCloseTo(1 / 3);
  });

  it("returns isolated session snapshots and a global aggregate", () => {
    const telemetry = new LocalTelemetryAggregator({
      requestedAdapter: "bun-sqlite",
      activeAdapter: "bun-sqlite",
    });
    telemetry.recordCompression({
      sessionID: "session-1",
      outcome: "compressed",
      reason: "compressed",
      estimatedTokensSaved: 100,
      latencyMs: 5,
    });
    telemetry.recordRetrieval({
      sessionID: "session-1",
      mode: "full",
      outcome: "hit",
      outputTokens: 120,
      latencyMs: 2,
    });
    telemetry.recordCompression({
      sessionID: "session-2",
      outcome: "compressed",
      reason: "compressed",
      estimatedTokensSaved: 40,
      latencyMs: 3,
    });
    telemetry.recordRetrieval({
      sessionID: "session-2",
      mode: "query",
      outcome: "hit",
      outputTokens: 10,
      latencyMs: 1,
    });

    expect(telemetry.snapshot("session-1")).toMatchObject({
      compressed: 1,
      grossEstimatedSavings: 100,
      retrievalCount: 1,
      retrievalTokensByMode: { full: 120, query: 0 },
      fullRetrieveRate: 1,
      estimatedNetSavings: -20,
      latency: { count: 2, totalMs: 7, maxMs: 5 },
    });
    expect(telemetry.snapshot()).toMatchObject({
      compressed: 2,
      grossEstimatedSavings: 140,
      retrievalCount: 2,
      retrievalTokensByMode: { full: 120, query: 10 },
      fullRetrieveRate: 0.5,
      estimatedNetSavings: 10,
      latency: { count: 4, totalMs: 11, maxMs: 5 },
    });
    expect(telemetry.snapshot("missing-session")).toMatchObject({
      compressed: 0,
      skipped: 0,
      error: 0,
      grossEstimatedSavings: 0,
      retrievalCount: 0,
      misses: 0,
      fullRetrieveRate: 0,
      estimatedNetSavings: 0,
      latency: { count: 0, totalMs: 0, maxMs: 0 },
    });
  });

  it("never copies output, args, path content, query text, or session ids into JSON", () => {
    const optionsWithSensitiveExtra = {
      requestedAdapter: "auto",
      activeAdapter: "memory",
      fallbackReason: "adapter_unavailable",
      path: "/private/adapter-SECRET",
    } as const;
    const telemetry = new LocalTelemetryAggregator(optionsWithSensitiveExtra);
    const compressionWithSensitiveExtras = {
      sessionID: "session-SECRET",
      outcome: "compressed",
      reason: "compressed",
      estimatedTokensSaved: 20,
      latencyMs: 1,
      output: "raw-output-SECRET",
      args: { token: "args-SECRET" },
      pathContent: "path-content-SECRET",
    } as const;
    const retrievalWithSensitiveExtras = {
      sessionID: "session-SECRET",
      mode: "query",
      outcome: "hit",
      outputTokens: 5,
      latencyMs: 1,
      query: "query-text-SECRET",
      output: "retrieve-output-SECRET",
    } as const;

    telemetry.recordCompression(compressionWithSensitiveExtras);
    telemetry.recordRetrieval(retrievalWithSensitiveExtras);

    const serialized = JSON.stringify(telemetry.snapshot("session-SECRET"));
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain('"output":');
    expect(serialized).not.toContain('"args":');
    expect(serialized).not.toContain('"pathContent":');
  });

  it("drops session-local counters when a session is deleted", () => {
    const telemetry = new LocalTelemetryAggregator({
      requestedAdapter: "memory",
      activeAdapter: "memory",
    });
    telemetry.recordCompression({
      sessionID: "session-1",
      outcome: "compressed",
      reason: "compressed",
      estimatedTokensSaved: 10,
      latencyMs: 1,
    });

    telemetry.deleteSession("session-1");

    expect(telemetry.snapshot("session-1").compressed).toBe(0);
    expect(telemetry.snapshot().compressed).toBe(1);
  });
});
