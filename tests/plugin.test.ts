import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { HeadroomNativePlugin } from "../src/plugin.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { createRetrieveTool } from "../src/tools/retrieve.js";
import { createStatsTool } from "../src/tools/stats.js";
import { searchFixture } from "./fixtures.js";

function pluginInput() {
  return {
    client: {},
    project: { id: "project-1" },
    directory: "/repo",
    worktree: "/repo",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {},
  } as never;
}

describe("native tools", () => {
  it("retrieve tool validates hash", async () => {
    const engine = new NativeHeadroomCompatibleEngine(new MemoryCCRStore());
    const retrieve = createRetrieveTool(engine);
    const result = await retrieve.execute({ hash: "bad" }, {} as never);
    const output = typeof result === "string" ? result : result.output;

    expect(output).toContain("Invalid hash");
  });

  it("stats tool returns session stats", async () => {
    const engine = new NativeHeadroomCompatibleEngine(new MemoryCCRStore());
    const stats = createStatsTool(engine);
    const result = await stats.execute(
      { sessionOnly: true },
      { sessionID: "s1" } as never,
    );
    const output = typeof result === "string" ? result : result.output;

    expect(output).toContain("engine: native");
  });
});

describe("OpenCode plugin", () => {
  it("registers after hook and tools", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
    });

    expect(plugin.tool?.headroom_retrieve).toBeDefined();
    expect(plugin.tool?.headroom_stats).toBeDefined();
    expect(plugin["tool.execute.after"]).toBeTypeOf("function");
  });

  it("compresses large tool output after execution", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const output = { title: "Bash", output: searchFixture(), metadata: {} };
    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "rg auth" },
      },
      output,
    );

    expect(output.output).toContain("[Retrieve more: hash=");
    expect(output.metadata.headroom.strategy).toBe("search");
  });

  it("skips ctx tools", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const original = searchFixture();
    const output = { title: "ctx_search", output: original, metadata: {} };
    await plugin["tool.execute.after"]!(
      { tool: "ctx_search", sessionID: "s1", callID: "c1", args: {} },
      output,
    );

    expect(output.output).toBe(original);
  });

  it("attaches compact debug metadata when enabled", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      debug: true,
      debugLevel: "trace",
      debugSink: "metadata",
    });
    const output = { title: "Bash", output: searchFixture(), metadata: {} };
    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "rg auth" },
      },
      output,
    );

    expect(output.metadata.headroom.debug).toMatchObject({
      decision: "compressed",
      router: { kind: "search" },
      compressor: {
        strategy: "search",
      },
      ccr: {
        stored: true,
        hash: output.metadata.headroom.hash,
      },
    });
    expect(output.metadata.headroom.debug.compressor.dropped.matches).toBeGreaterThan(0);
  });

  it("writes one NDJSON trace record when file debug is enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-debug-"));
    const debugPath = join(dir, "debug.ndjson");
    try {
      const plugin = await HeadroomNativePlugin(pluginInput(), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        debug: true,
        debugLevel: "trace",
        debugSink: "file",
        debugPath,
      });
      const output = { title: "Bash", output: searchFixture(), metadata: {} };
      await plugin["tool.execute.after"]!(
        {
          tool: "Bash",
          sessionID: "s1",
          callID: "c1",
          args: { command: "rg auth" },
        },
        output,
      );

      expect(existsSync(debugPath)).toBe(true);
      const lines = readFileSync(debugPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!);
      expect(record).toMatchObject({
        sessionID: "s1",
        callID: "c1",
        tool: "Bash",
        decision: "compressed",
        router: { kind: "search" },
        ccr: { stored: true },
      });
      expect(record.compressor.kept.matches).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not change compressed output when debug is enabled", async () => {
    const basePlugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const debugPlugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      debug: true,
      debugLevel: "trace",
      debugSink: "metadata",
    });
    const baseOutput = { title: "Bash", output: searchFixture(), metadata: {} };
    const debugOutput = { title: "Bash", output: searchFixture(), metadata: {} };

    await basePlugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "rg auth" },
      },
      baseOutput,
    );
    await debugPlugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "s1",
        callID: "c1",
        args: { command: "rg auth" },
      },
      debugOutput,
    );

    expect(debugOutput.output).toBe(baseOutput.output);
    expect(debugOutput.metadata.headroom.hash).toBe(baseOutput.metadata.headroom.hash);
  });
});
