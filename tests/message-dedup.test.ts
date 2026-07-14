import { describe, expect, it } from "vitest";

import { HeadroomNativePlugin } from "../src/plugin.js";
import { deduplicateMessageToolOutputs } from "../src/session/message-dedup.js";

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

function lines(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix} record ${index}: stable payload ${index}`,
  );
}

function completedTool(output: string) {
  return {
    type: "tool",
    state: {
      status: "completed",
      output,
      title: "Bash",
      input: {},
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function lifecycleTool(
  tool: "Read" | "Edit",
  callID: string,
  filePath: string,
  output: string,
) {
  return {
    id: `${callID}-part`,
    sessionID: "lifecycle-session",
    messageID: `${callID}-message`,
    type: "tool",
    callID,
    tool,
    state: {
      status: "completed",
      input: { filePath },
      output,
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

describe("OpenCode message span deduplication", () => {
  it("rewrites only later completed tool output spans", () => {
    const shared = lines("shared", 60);
    const first = [...shared, ...lines("old", 20)].join("\n");
    const second = [...shared, ...lines("new", 20)].join("\n");
    const messages = [
      { info: {}, parts: [{ type: "text", text: "user prompt" }, completedTool(first)] },
      {
        info: {},
        parts: [
          { type: "tool", state: { status: "running", input: {}, raw: "" } },
          completedTool(second),
        ],
      },
    ];

    const stats = deduplicateMessageToolOutputs(messages);

    expect(messages[0]?.parts[1]).toMatchObject({ state: { output: first } });
    expect(messages[1]?.parts[0]).toMatchObject({ state: { status: "running" } });
    expect(messages[1]?.parts[1]).toMatchObject({
      state: { output: expect.stringContaining("[↑60L same as msg 1") },
    });
    expect(stats.spansFolded).toBe(1);
  });

  it("uses the experimental message-transform hook without requiring a proxy", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
    });
    const shared = lines("shared", 12).join("\n");
    const messages = [
      { info: {}, parts: [completedTool(shared)] },
      { info: {}, parts: [completedTool(`${shared}\nunique tail`)] },
    ];

    await plugin["experimental.chat.messages.transform"]!(
      {},
      { messages } as never,
    );

    expect(messages[0]?.parts[0]).toMatchObject({ state: { output: shared } });
    expect(messages[1]?.parts[0]).toMatchObject({
      state: { output: expect.stringContaining("same as msg 1") },
    });
  });

  it("folds stale Reads through the plugin hook and retrieves the exact original", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
    });
    const original = lines("old source", 80).join("\n");
    const read = lifecycleTool("Read", "read-call", "src/auth.ts", original);
    const edit = lifecycleTool("Edit", "edit-call", "src/auth.ts", "Done");
    const messages = [
      { info: {}, parts: [read] },
      { info: {}, parts: [edit] },
    ];

    await plugin["experimental.chat.messages.transform"]!(
      {},
      { messages } as never,
    );

    expect(read.state.output).toContain("is stale after a later write");
    const hash = read.state.output.match(/hash=([0-9a-f]{24})/)?.[1];
    expect(hash).toBeDefined();
    const retrieved = await plugin.tool!.headroom_retrieve.execute(
      { hash: hash!, mode: "full" },
      { sessionID: "lifecycle-session" } as never,
    );
    expect(typeof retrieved === "string" ? retrieved : retrieved.output).toBe(
      original,
    );
  });

  it("leaves stale Reads exact under the legacy profile", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      profile: "legacy",
      storage: { kind: "memory" },
    });
    const original = lines("legacy source", 80).join("\n");
    const read = lifecycleTool("Read", "legacy-read", "src/legacy.ts", original);
    const edit = lifecycleTool("Edit", "legacy-edit", "src/legacy.ts", "Done");
    const messages = [
      { info: {}, parts: [read] },
      { info: {}, parts: [edit] },
    ];

    await plugin["experimental.chat.messages.transform"]!(
      {},
      { messages } as never,
    );

    expect(read.state.output).toBe(original);
  });
});
