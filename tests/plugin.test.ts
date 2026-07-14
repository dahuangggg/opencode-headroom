import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { HeadroomNativePlugin } from "../src/plugin.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { createRetrieveTool } from "../src/tools/retrieve.js";
import { createStatsTool } from "../src/tools/stats.js";
import { logFixture, searchFixture } from "./fixtures.js";

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

  it("retrieve tool forwards partial retrieval arguments", async () => {
    const engine = new NativeHeadroomCompatibleEngine(new MemoryCCRStore());
    const compressed = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "rg auth" },
      output: searchFixture(),
      ttlMs: 60_000,
    });
    const retrieve = createRetrieveTool(engine);

    const result = await retrieve.execute(
      {
        hash: compressed.hash!,
        mode: "query",
        query: "ERROR token rejected",
        contextLines: 1,
      },
      {} as never,
    );
    const output = typeof result === "string" ? result : result.output;

    expect(output).toContain("mode: query");
    expect(output).toContain("ERROR auth token rejected");
    expect(output).not.toBe(searchFixture());
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
    expect(plugin["chat.message"]).toBeTypeOf("function");
    expect(plugin["experimental.chat.messages.transform"]).toBeTypeOf("function");
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

  it("stores full OpenCode outputPath content when display output was truncated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-output-"));
    const fullOutputPath = join(dir, "tool-output.txt");
    const fullOutput = [
      logFixture(),
      ...Array.from(
        { length: 40 },
        (_, index) =>
          `INFO preserved full tail line ${index + 1} /data/report_${index + 1}.json`,
      ),
    ].join("\n");
    writeFileSync(fullOutputPath, fullOutput, "utf8");

    try {
      const plugin = await HeadroomNativePlugin(pluginInput(), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        debug: true,
        debugLevel: "trace",
        debugSink: "metadata",
        outputFiles: {
          allowedRoots: [dir],
          trustedTools: ["Bash"],
        },
      });
      const displayOutput = [
        "...output truncated...",
        "INFO processing item 1",
        "Click to expand",
      ].join("\n");
      const output = {
        title: "Bash",
        output: displayOutput,
        metadata: {
          truncated: true,
          outputPath: fullOutputPath,
        },
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "Bash",
          sessionID: "s1",
          callID: "c1",
          args: { command: "cat tool-output.txt" },
        },
        output,
      );

      expect(output.output).toContain("[Retrieve more: hash=");
      expect(output.metadata.headroom.source).toMatchObject({
        kind: "outputPath",
        path: fullOutputPath,
        displayChars: displayOutput.length,
        originalChars: fullOutput.length,
      });
      expect(output.metadata.headroom.debug.source).toMatchObject({
        kind: "outputPath",
        path: fullOutputPath,
      });

      const retrieveResult = await plugin.tool!.headroom_retrieve.execute(
        { hash: output.metadata.headroom.hash, mode: "full" },
        { sessionID: "s1" } as never,
      );
      const retrievedOutput =
        typeof retrieveResult === "string" ? retrieveResult : retrieveResult.output;
      expect(retrievedOutput).toBe(fullOutput);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("does not read OpenCode outputPath for skipped tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-skip-output-"));
    const fullOutputPath = join(dir, "retrieved-output.txt");
    writeFileSync(fullOutputPath, logFixture(), "utf8");

    try {
      const plugin = await HeadroomNativePlugin(pluginInput(), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        debug: true,
        debugLevel: "trace",
        debugSink: "metadata",
      });
      const displayOutput = "...output truncated...\nRetrieve output display";
      const output = {
        title: "headroom_retrieve",
        output: displayOutput,
        metadata: {
          truncated: true,
          outputPath: fullOutputPath,
        },
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "headroom_retrieve",
          sessionID: "s1",
          callID: "c1",
          args: { hash: "abcdef012345abcdef012345" },
        },
        output,
      );

      expect(output.output).toBe(displayOutput);
      expect(output.metadata.headroom.debug).toMatchObject({
        decision: "skipped",
        reason: "builtin_preserve",
        policy: {
          ruleId: "safety-headroom-tools",
          source: "builtin",
        },
        source: {
          kind: "toolOutput",
          displayChars: displayOutput.length,
          originalChars: displayOutput.length,
        },
      });
      expect(output.metadata.headroom.debug.source.path).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("reports debug file write status in metadata when both debug sinks are enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-debug-"));
    const debugPath = "debug.ndjson";
    try {
      const plugin = await HeadroomNativePlugin(
        {
          ...pluginInput(),
          directory: dir,
          worktree: "/",
        } as never,
        {
          storage: { kind: "memory" },
          thresholdChars: 10,
          thresholdTokens: 1,
          debug: true,
          debugLevel: "trace",
          debugSink: "both",
          debugPath,
        },
      );
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

      expect(output.metadata.headroom.debugFile).toMatchObject({
        path: join(dir, debugPath),
        written: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps hook output and telemetry stable when the debug path is unwritable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-debug-failure-"));
    try {
      const plugin = await HeadroomNativePlugin(
        {
          ...pluginInput(),
          directory: dir,
          worktree: dir,
        } as never,
        {
          storage: { kind: "memory" },
          thresholdChars: 10,
          thresholdTokens: 1,
          debug: true,
          debugSink: "both",
          // appendFile cannot write to a directory, on every supported OS.
          debugPath: dir,
        },
      );
      const output = { title: "Bash", output: searchFixture(), metadata: {} as any };

      await plugin["tool.execute.after"]!(
        {
          tool: "Bash",
          sessionID: "s1",
          callID: "debug-write-failure",
          args: { command: "rg auth" },
        },
        output,
      );
      const stats = await plugin.tool!.headroom_stats.execute(
        { sessionOnly: true },
        { sessionID: "s1" } as never,
      );
      const statsText =
        typeof stats === "string" ? stats : (stats as { output: string }).output;

      expect(output.output).toContain("[Retrieve more: hash=");
      expect(output.metadata.headroom.debugFile).toMatchObject({
        path: dir,
        written: false,
      });
      expect(output.metadata.headroom.debugFile.error).toBeTruthy();
      expect(statsText).toContain("compressed=1, skipped=0, error=0");
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

  it("keeps policy context when the hook fails open", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      ttlHours: Number.MAX_VALUE,
      debug: true,
      debugSink: "metadata",
    });
    const original = searchFixture();
    const output = { title: "Bash", output: original, metadata: {} as any };

    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "s1",
        callID: "failing-call",
        args: { command: "rg auth" },
      },
      output,
    );

    expect(output.output).toBe(original);
    expect(output.metadata.headroom.debug).toMatchObject({
      decision: "error",
      reason: "hook_error",
      policy: {
        ruleId: "default",
        source: "default",
        action: "compress",
        strength: "balanced",
      },
      threshold: { chars: 10, tokens: 1 },
    });
  });

  it("deletes session CCR data on session.deleted and exposes dispose", async () => {
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

    expect(plugin.event).toBeTypeOf("function");
    expect(plugin.dispose).toBeTypeOf("function");
    await plugin.event!({
      event: {
        type: "session.deleted",
        properties: { info: { id: "s1" } },
      },
    } as never);

    const retrieved = await plugin.tool!.headroom_retrieve.execute(
      { hash: output.metadata.headroom.hash, mode: "full" },
      { sessionID: "s1" } as never,
    );
    const content =
      typeof retrieved === "string" ? retrieved : retrieved.output;
    expect(content).toContain("not found or expired");

    const afterDelete = { title: "Bash", output: searchFixture(), metadata: {} };
    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "s1",
        callID: "c2",
        args: { command: "rg auth" },
      },
      afterDelete,
    );
    expect(afterDelete.metadata.headroom.strategy).toBe("search");

    await plugin.dispose!();
  });

  it("reports local adapter, compression, retrieval cost, and session isolation with debug off", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      debug: false,
    });
    const compressed = { title: "Bash", output: searchFixture(), metadata: {} };
    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "telemetry-s1",
        callID: "telemetry-c1",
        args: { command: "rg auth" },
      },
      compressed,
    );
    const skipped = { title: "Bash", output: "small", metadata: {} };
    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "telemetry-s2",
        callID: "telemetry-c2",
        args: { command: "echo small" },
      },
      skipped,
    );
    await plugin.tool!.headroom_retrieve.execute(
      { hash: compressed.metadata.headroom.hash, mode: "full" },
      { sessionID: "telemetry-s1" } as never,
    );

    const sessionStats = await plugin.tool!.headroom_stats.execute(
      { sessionOnly: true },
      { sessionID: "telemetry-s1" } as never,
    );
    const globalStats = await plugin.tool!.headroom_stats.execute(
      { sessionOnly: false },
      { sessionID: "telemetry-s1" } as never,
    );
    const sessionOutput =
      typeof sessionStats === "string" ? sessionStats : sessionStats.output;
    const globalOutput =
      typeof globalStats === "string" ? globalStats : globalStats.output;

    expect(sessionOutput).toContain("storage adapter: memory -> memory");
    expect(sessionOutput).toContain(
      "compression outcomes: compressed=1, skipped=0, error=0",
    );
    expect(sessionOutput).toContain("retrievals: 1");
    expect(sessionOutput).toMatch(/retrieval tokens: .*full=[1-9]\d*/);
    expect(sessionOutput).toMatch(/estimated net savings: -?\d+/);
    expect(globalOutput).toContain(
      "compression outcomes: compressed=1, skipped=1, error=0",
    );
  });
});
