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
});
