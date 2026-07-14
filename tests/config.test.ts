import { describe, expect, it } from "vitest";

import { normalizeConfig, shouldSkipTool } from "../src/config.js";

describe("normalizeConfig", () => {
  it("applies coding-profile defaults", () => {
    const config = normalizeConfig();

    expect(config.engine).toBe("native");
    expect(config.profile).toBe("coding");
    expect(config.thresholdTokens).toBe(25);
    expect(config.thresholdChars).toBe(25);
    expect(config.ttlHours).toBe(24);
    expect(config.storage).toEqual({
      kind: "auto",
      path: ".headroom/ccr.sqlite",
      maxEntries: 10_000,
      busyTimeoutMs: 5_000,
    });
    expect(config.skipTools).toEqual(["headroom_*", "ctx_*"]);
    expect(config.maxOutputChars).toBe(250000);
    expect(config.debug).toBe(false);
    expect(config.debugLevel).toBe("summary");
    expect(config.debugSink).toBe("metadata");
    expect(config.debugPath).toBe(".headroom/debug.ndjson");
  });

  it("keeps the previous thresholds behind the legacy profile", () => {
    const config = normalizeConfig({ profile: "legacy" });

    expect(config.profile).toBe("legacy");
    expect(config.thresholdTokens).toBe(2000);
    expect(config.thresholdChars).toBe(8000);
  });

  it("lets explicit thresholds override profile defaults", () => {
    expect(
      normalizeConfig({
        profile: "legacy",
        thresholdTokens: 80,
        thresholdChars: 320,
      }),
    ).toMatchObject({
      profile: "legacy",
      thresholdTokens: 80,
      thresholdChars: 320,
    });
  });

  it("accepts planned storage backends", () => {
    expect(normalizeConfig({ storage: { kind: "memory" } }).storage.kind).toBe(
      "memory",
    );
    expect(
      normalizeConfig({ storage: { kind: "bun-sqlite", path: "/tmp/x.db" } })
        .storage,
    ).toEqual({
      kind: "bun-sqlite",
      path: "/tmp/x.db",
      maxEntries: 10_000,
      busyTimeoutMs: 5_000,
    });
    expect(
      normalizeConfig({ storage: { kind: "memory", maxEntries: 25 } }).storage
        .maxEntries,
    ).toBe(25);
  });

  it("accepts debug trace options", () => {
    expect(
      normalizeConfig({
        debug: true,
        debugLevel: "trace",
        debugSink: "both",
        debugPath: "/tmp/headroom-debug.ndjson",
      }),
    ).toMatchObject({
      debug: true,
      debugLevel: "trace",
      debugSink: "both",
      debugPath: "/tmp/headroom-debug.ndjson",
    });
  });

  it("rejects unsupported engines", () => {
    expect(() => normalizeConfig({ engine: "headroom-http" as never })).toThrow(
      /Unsupported engine/,
    );
    expect(() => normalizeConfig({ profile: "unknown" as never })).toThrow(
      /profile must be one of: coding, legacy/,
    );
  });

  it("rejects invalid limits, storage, and debug enums at initialization", () => {
    expect(() => normalizeConfig({ thresholdTokens: 0 })).toThrow(
      /thresholdTokens must be a positive finite number/,
    );
    expect(() => normalizeConfig({ ttlHours: Number.NaN })).toThrow(
      /ttlHours must be a positive finite number/,
    );
    expect(() => normalizeConfig({ maxOutputChars: 1.5 })).toThrow(
      /maxOutputChars must be a positive safe integer/,
    );
    expect(() =>
      normalizeConfig({ storage: { kind: "remote" as never } }),
    ).toThrow(/storage\.kind/);
    expect(() =>
      normalizeConfig({ storage: { maxEntries: 0 } }),
    ).toThrow(/storage\.maxEntries.*positive safe integer/);
    expect(() =>
      normalizeConfig({ storage: { busyTimeoutMs: -1 } }),
    ).toThrow(/storage\.busyTimeoutMs.*non-negative safe integer/);
    expect(() =>
      normalizeConfig({ debugLevel: "verbose" as never }),
    ).toThrow(/debugLevel/);
    expect(() =>
      normalizeConfig({ skipTools: "Bash" as never }),
    ).toThrow(/skipTools must be an array/);
    expect(() =>
      normalizeConfig({ storage: { path: 42 as never } }),
    ).toThrow(/storage\.path/);
  });

  it("validates trusted output-file selectors", () => {
    expect(() =>
      normalizeConfig({ outputFiles: { trustedTools: [""] } }),
    ).toThrow(/trustedTools.*non-empty/i);
    expect(() =>
      normalizeConfig({ outputFiles: { allowedRoots: ["   "] } }),
    ).toThrow(/allowedRoots.*non-empty/i);
    expect(() =>
      normalizeConfig({
        outputFiles: { allowedRoots: "." as never },
      }),
    ).toThrow(/allowedRoots must be an array/i);
    expect(() =>
      normalizeConfig({
        outputFiles: { trustedTools: [42 as never] },
      }),
    ).toThrow(/trustedTools.*non-empty strings/i);
  });

  it("rejects null tool policy defaults", () => {
    expect(() =>
      normalizeConfig({ toolPolicy: { default: null } as never }),
    ).toThrow(/toolPolicy\.default must be an object/i);
  });
});

describe("shouldSkipTool", () => {
  it("supports exact names and trailing-star prefix patterns", () => {
    const config = normalizeConfig({ skipTools: ["ctx_*", "Read"] });

    expect(shouldSkipTool("ctx_search", config)).toBe(true);
    expect(shouldSkipTool("Read", config)).toBe(true);
    expect(shouldSkipTool("Bash", config)).toBe(false);
  });
});
