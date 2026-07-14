import { describe, expect, it } from "vitest";

import {
  compressByContentType,
  detectContentType,
  executeStrategyWithBreaker,
  stripDetectionEnvelope,
} from "../src/engine/router.js";
import { StrategyCircuitBreaker } from "../src/engine/resilience.js";

describe("content router detection", () => {
  it("strips full tool output envelopes for detection only", () => {
    const wrapped =
      "<returncode>0</returncode>\n<output>\nsrc/a.ts:10:match\n</output>";

    expect(stripDetectionEnvelope(wrapped)).toBe("src/a.ts:10:match");
  });

  it("detects JSON arrays and objects", () => {
    expect(detectContentType('[{"id":1}]').kind).toBe("json");
    expect(detectContentType('{"id":1}').kind).toBe("json");
  });

  it("compresses the routed JSON payload and preserves its output envelope", () => {
    const hash = "0123456789abcdef01234567";
    const body = JSON.stringify(
      Array.from({ length: 40 }, (_, index) => ({
        id: index + 1,
        status: "ok",
        message: `event ${index + 1}`,
      })),
    );
    const wrapped = `<returncode>0</returncode>\n<output>\n${body}\n</output>`;

    const result = compressByContentType({
      content: wrapped,
      hash,
      query: "",
    });

    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("json");
    expect(result.output).toMatch(
      /^<returncode>0<\/returncode>\n<output>\n[\s\S]*\n<\/output>$/,
    );
    expect(JSON.parse(stripDetectionEnvelope(result.output))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _ccr_dropped: expect.stringMatching(
            new RegExp(`^<<ccr:${hash} \\d+_rows_offloaded>>$`),
          ),
        }),
      ]),
    );
  });

  it("detects diff before search", () => {
    const diff =
      "diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n+src/a.ts:10:still diff";

    expect(detectContentType(diff).kind).toBe("diff");
  });

  it("detects search output", () => {
    const result = detectContentType(
      "src/a.ts:10:const x = 1;\nsrc/a.ts:20:const y = 2;",
    );

    expect(result.kind).toBe("search");
  });

  it("detects logs", () => {
    const result = detectContentType(
      "2026-01-01 starting\nERROR failed\nWARNING retrying",
    );

    expect(result.kind).toBe("log");
  });

  it("does not treat ISO timestamps as search results", () => {
    expect(
      detectContentType("2026-01-01 10:22:33 ERROR failed").kind,
    ).toBe("log");
    expect(
      detectContentType("2026-01-01T10:22:33Z ERROR failed").kind,
    ).toBe("log");
    expect(
      detectContentType("2026-01-01T10:22:33.123Z ERROR failed").kind,
    ).toBe("log");
  });

  it("routes obvious source code through syntax-aware compression", () => {
    const source = Array.from(
      { length: 60 },
      (_, index) =>
        [
          `export function value${index}(input: number): number {`,
          `  const stage0 = input + ${index};`,
          "  const stage1 = stage0 + 1;",
          "  const stage2 = stage1 + 2;",
          "  const stage3 = stage2 + 3;",
          "  const stage4 = stage3 + 4;",
          "  const stage5 = stage4 + 5;",
          "  return stage5;",
          "}",
        ].join("\n"),
    ).join("\n\n");

    const result = compressByContentType({
      content: source,
      hash: "0123456789abcdef01234567",
      query: "",
    });

    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("code");
    expect(result.output).toContain(
      "export function value0(input: number): number {",
    );
    expect(result.output).not.toContain("const stage4 = stage3 + 4;");
  });

  it("compresses explicit mixed sections and preserves their exact framing", () => {
    const hash = "0123456789abcdef01234567";
    const stdout = JSON.stringify(
      Array.from({ length: 40 }, (_, index) => ({
        id: index + 1,
        status: "ok",
        message: `event ${index + 1}`,
      })),
    );
    const stderr = "WARNING retry scheduled";
    const mixed = [
      "<returncode>0</returncode>",
      `<stdout>\n${stdout}\n</stdout>`,
      "",
      `<stderr>\n${stderr}\n</stderr>`,
      "",
    ].join("\n");

    const result = compressByContentType({
      content: mixed,
      hash,
      query: "",
    });
    const stdoutMatch = /<stdout>\n(?<body>[\s\S]*?)\n<\/stdout>/.exec(
      result.output,
    );

    expect(result.changed).toBe(true);
    expect(
      result.output.startsWith("<returncode>0</returncode>\n<stdout>\n"),
    ).toBe(true);
    expect(result.output).toContain(
      `</stdout>\n\n<stderr>\n${stderr}\n</stderr>\n`,
    );
    expect(result.output.endsWith("\n")).toBe(true);
    expect(JSON.parse(stdoutMatch?.groups?.body ?? "null")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _ccr_dropped: expect.stringMatching(
            new RegExp(`^<<ccr:${hash} \\d+_rows_offloaded>>$`),
          ),
        }),
      ]),
    );
  });

  it("preserves code and diff sections while compressing other explicit sections", () => {
    const code = Array.from(
      { length: 20 },
      (_, index) =>
        [
          `export function value${index}(input: number): number {`,
          `  const stage0 = input + ${index};`,
          "  const stage1 = stage0 + 1;",
          "  const stage2 = stage1 + 2;",
          "  const stage3 = stage2 + 3;",
          "  const stage4 = stage3 + 4;",
          "  const stage5 = stage4 + 5;",
          "  return stage5;",
          "}",
        ].join("\n"),
    ).join("\n\n");
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-const value = 1;",
      "+const value = 2;",
    ].join("\n");
    const json = JSON.stringify(
      Array.from({ length: 40 }, (_, index) => ({
        id: index + 1,
        status: "ok",
        message: `event ${index + 1}`,
      })),
    );
    const mixed = [
      `<stdout>\n${code}\n</stdout>`,
      `<stderr>\n${diff}\n</stderr>`,
      `<output>\n${json}\n</output>`,
    ].join("\n");

    const result = compressByContentType({
      content: mixed,
      hash: "0123456789abcdef01234567",
      query: "",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("<stdout>\n");
    expect(result.output).toContain(
      "export function value0(input: number): number {",
    );
    expect(result.output).toContain(`<stderr>\n${diff}\n</stderr>`);
    expect(result.output.indexOf("<stdout>")).toBeLessThan(
      result.output.indexOf("<stderr>"),
    );
    expect(result.output.indexOf("<stderr>")).toBeLessThan(
      result.output.indexOf("<output>"),
    );
    expect(result.debug?.router?.metadata.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "stdout",
          kind: "code",
          changed: true,
        }),
        expect.objectContaining({
          tag: "stderr",
          changed: false,
          reason: "too_few_lines",
        }),
      ]),
    );
  });

  it("passes an explicit mixed output through when no section has savings", () => {
    const mixed =
      "<stdout>\ncommand completed\n</stdout>\n<stderr>\nretry pending\n</stderr>";

    const result = compressByContentType({
      content: mixed,
      hash: "0123456789abcdef01234567",
      query: "",
    });

    expect(result.changed).toBe(false);
    expect(result.output).toBe(mixed);
    expect(result.reason).toBe("mixed_passthrough");
  });

  it("routes table and HTML strategies inside explicit mixed sections", () => {
    const table = [
      "| tenant | status |",
      "| --- | --- |",
      ...Array.from({ length: 40 }, (_, index) =>
        index === 30 ? "| critical | ERROR |" : `| tenant-${index} | ok |`,
      ),
    ].join("\n");
    const html = [
      "<html><head><title>Runbook</title></head><body><main>",
      "<p>Security error requires rotation.</p>",
      ...Array.from({ length: 30 }, (_, index) => `<p>Routine ${index}</p>`),
      "</main></body></html>",
    ].join("\n");
    const result = compressByContentType({
      content: `<output>\n${table}\n</output>\n<result>\n${html}\n</result>`,
      hash: "0123456789abcdef01234567",
      query: "critical rotation",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("| critical | ERROR |");
    expect(result.output).toContain("Security error requires rotation.");
    expect(result.debug?.router?.metadata.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "table", changed: true }),
        expect.objectContaining({ kind: "html", changed: true }),
      ]),
    );
  });

  it("does not infer mixed sections from blank-line-separated prose", () => {
    const prose = "first paragraph\n\nsecond paragraph\n\nthird paragraph";

    const result = compressByContentType({
      content: prose,
      hash: "0123456789abcdef01234567",
      query: "",
    });

    expect(result.debug?.router?.metadata.mixed).toBeUndefined();
  });

  it("falls back to text", () => {
    expect(detectContentType("plain prose with no strong structure").kind).toBe(
      "text",
    );
  });
});

describe("strategy circuit breaker routing", () => {
  const input = {
    content: "exact raw tool output",
    hash: "0123456789abcdef01234567",
    query: "",
  };

  it("rethrows the first three failures, then bypasses the open strategy", () => {
    const breaker = new StrategyCircuitBreaker();
    let calls = 0;
    const operation = () => {
      calls += 1;
      throw new Error("compressor failed");
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() =>
        executeStrategyWithBreaker("code", input, operation, breaker),
      ).toThrow("compressor failed");
    }

    expect(
      executeStrategyWithBreaker("code", input, operation, breaker),
    ).toEqual({
      changed: false,
      output: input.content,
      strategy: "code",
      reason: "strategy_circuit_open",
      cacheable: false,
    });
    expect(calls).toBe(3);
  });

  it("isolates an open code strategy from log and text operations", () => {
    const breaker = new StrategyCircuitBreaker({ failureThreshold: 1 });
    expect(() =>
      executeStrategyWithBreaker(
        "code",
        input,
        () => {
          throw new Error("code failed");
        },
        breaker,
      ),
    ).toThrow("code failed");

    let logCalls = 0;
    let textCalls = 0;
    const logResult = executeStrategyWithBreaker(
      "log",
      input,
      () => {
        logCalls += 1;
        return {
          changed: false,
          output: input.content,
          strategy: "log" as const,
          reason: "log_passthrough",
        };
      },
      breaker,
    );
    const textResult = executeStrategyWithBreaker(
      "text",
      input,
      () => {
        textCalls += 1;
        return {
          changed: false,
          output: input.content,
          strategy: "text" as const,
          reason: "text_passthrough",
        };
      },
      breaker,
    );

    expect(logCalls).toBe(1);
    expect(textCalls).toBe(1);
    expect(logResult.reason).toBe("log_passthrough");
    expect(textResult.reason).toBe("text_passthrough");
    expect(
      executeStrategyWithBreaker(
        "code",
        input,
        () => {
          throw new Error("must not run");
        },
        breaker,
      ).reason,
    ).toBe("strategy_circuit_open");
  });

  it("records success and resets consecutive failures", () => {
    const breaker = new StrategyCircuitBreaker();
    let calls = 0;
    const fail = () => {
      calls += 1;
      throw new Error("compressor failed");
    };
    const succeed = () => {
      calls += 1;
      return {
        changed: false,
        output: input.content,
        strategy: "json" as const,
        reason: "already_concise",
      };
    };

    expect(() =>
      executeStrategyWithBreaker("json", input, fail, breaker),
    ).toThrow("compressor failed");
    expect(() =>
      executeStrategyWithBreaker("json", input, fail, breaker),
    ).toThrow("compressor failed");
    expect(
      executeStrategyWithBreaker("json", input, succeed, breaker).reason,
    ).toBe("already_concise");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() =>
        executeStrategyWithBreaker("json", input, fail, breaker),
      ).toThrow("compressor failed");
    }
    expect(
      executeStrategyWithBreaker("json", input, fail, breaker).reason,
    ).toBe("strategy_circuit_open");
    expect(calls).toBe(6);
  });

  it("returns exact routed input when the detected strategy is open", () => {
    const breaker = new StrategyCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("code");
    const source = [
      "export function value(input: number): number {",
      "  const stage0 = input + 1;",
      "  const stage1 = stage0 + 1;",
      "  return stage1;",
      "}",
    ].join("\n");

    const result = compressByContentType(
      { ...input, content: source },
      { losslessThenLossy: true },
      { circuitBreaker: breaker },
    );

    expect(result).toMatchObject({
      changed: false,
      output: source,
      strategy: "code",
      reason: "strategy_circuit_open",
    });
  });

  it("passes the same breaker through explicit mixed-section recursion", () => {
    const breaker = new StrategyCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("json");
    const json = JSON.stringify(
      Array.from({ length: 40 }, (_, index) => ({
        id: index,
        status: "ok",
      })),
    );
    const mixed = `<stdout>\n${json}\n</stdout>\n<stderr>\nretry pending\n</stderr>`;

    const result = compressByContentType(
      { ...input, content: mixed },
      {},
      { circuitBreaker: breaker },
    );

    expect(result.changed).toBe(false);
    expect(result.output).toBe(mixed);
    expect(result.cacheable).toBe(false);
    expect(result.debug?.router?.metadata.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "stdout",
          kind: "json",
          changed: false,
          reason: "strategy_circuit_open",
        }),
      ]),
    );
  });
});
