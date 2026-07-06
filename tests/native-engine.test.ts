import { describe, expect, it } from "vitest";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { largeJsonArrayFixture, searchFixture } from "./fixtures.js";

describe("native engine", () => {
  it("compresses and stores original output", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const original = largeJsonArrayFixture();
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "cat data.json" },
      output: original,
      ttlMs: 60_000,
    });

    expect(result.changed).toBe(true);
    expect(result.hash).toMatch(/^[a-f0-9]{24}$/);
    expect(result.output).toContain(result.hash);
    expect(await engine.retrieve(result.hash!)).toEqual({
      found: true,
      output: original,
    });
  });

  it("does not store when compression has no savings", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: {},
      output: "small",
      ttlMs: 60_000,
    });

    expect(result.changed).toBe(false);
    expect((await store.stats()).entryCount).toBe(0);
  });

  it("does not double-compress marked output", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const output = "already compressed\n[Retrieve more: hash=1234567890abcdef12345678]";
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: {},
      output,
      ttlMs: 60_000,
    });

    expect(result.changed).toBe(false);
    expect(result.output).toBe(output);
    expect(result.reason).toBe("empty_or_marked");
    expect((await store.stats()).entryCount).toBe(0);
  });

  it("reports stats", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "rg auth" },
      output: searchFixture(),
      ttlMs: 60_000,
    });

    const stats = await engine.stats("s1");
    expect(stats.output).toContain("entries: 1");
    expect(stats.output).toContain("tokens saved");
  });
});
