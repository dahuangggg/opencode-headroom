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

function hostTool(
  sessionID: string,
  messageID: string,
  callID: string,
  output: string,
) {
  return {
    id: `${callID}-part`,
    sessionID,
    messageID,
    callID,
    tool: "Bash",
    ...completedTool(output),
  };
}

function hostMessage(
  sessionID: string,
  messageID: string,
  parts: readonly unknown[],
) {
  return {
    info: { id: messageID, sessionID, role: "assistant" },
    parts,
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

  it("uses frozen tool outputs as references without mutating them", () => {
    const shared = lines("shared", 60);
    const first = completedTool([...shared, ...lines("old", 20)].join("\n"));
    const secondOutput = [...shared, ...lines("new", 20)].join("\n");
    const second = completedTool(secondOutput);

    const stats = deduplicateMessageToolOutputs(
      [
        { info: {}, parts: [first] },
        { info: {}, parts: [second] },
      ],
      { canMutateToolPart: () => false },
    );

    expect(second.state.output).toBe(secondOutput);
    expect(stats.spansFolded).toBe(0);
  });

  it("keeps existing history byte-exact on the first plugin transform", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
    });
    const shared = lines("shared", 60);
    const firstOutput = [...shared, ...lines("old", 20)].join("\n");
    const secondOutput = [...shared, ...lines("new", 20)].join("\n");
    const first = hostTool("existing-session", "message-1", "call-1", firstOutput);
    const second = hostTool("existing-session", "message-2", "call-2", secondOutput);
    const messages = [
      hostMessage("existing-session", "message-1", [first]),
      hostMessage("existing-session", "message-2", [second]),
    ];

    await plugin["experimental.chat.messages.transform"]!(
      {},
      { messages } as never,
    );

    expect(first.state.output).toBe(firstOutput);
    expect(second.state.output).toBe(secondOutput);
  });

  it("uses the experimental message-transform hook without requiring a proxy", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
    });
    const shared = lines("shared", 12).join("\n");
    const first = hostTool("dedup-session", "message-1", "call-1", shared);
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [hostMessage("dedup-session", "message-1", [first])],
      } as never,
    );
    const replayed = hostTool("dedup-session", "message-1", "call-1", shared);
    const appended = hostTool(
      "dedup-session",
      "message-2",
      "call-2",
      `${shared}\nunique tail`,
    );
    const messages = [
      hostMessage("dedup-session", "message-1", [replayed]),
      hostMessage("dedup-session", "message-2", [appended]),
    ];

    await plugin["experimental.chat.messages.transform"]!(
      {},
      { messages } as never,
    );

    expect(replayed.state.output).toBe(shared);
    expect(appended.state.output).toContain("same as msg 1");

    const sentRepresentation = appended.state.output;
    const reloadedFirst = hostTool(
      "dedup-session",
      "message-1",
      "call-1",
      shared,
    );
    const reloadedSecond = hostTool(
      "dedup-session",
      "message-2",
      "call-2",
      `${shared}\nunique tail`,
    );
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          hostMessage("dedup-session", "message-1", [reloadedFirst]),
          hostMessage("dedup-session", "message-2", [reloadedSecond]),
        ],
      } as never,
    );

    expect(reloadedFirst.state.output).toBe(shared);
    expect(reloadedSecond.state.output).toBe(sentRepresentation);
  });

  it("folds stale Reads through the plugin hook and retrieves the exact original", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
    });
    const original = lines("old source", 80).join("\n");
    const read = lifecycleTool("Read", "read-call", "src/auth.ts", original);
    const edit = lifecycleTool("Edit", "edit-call", "src/auth.ts", "Done");
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [hostMessage("lifecycle-session", "seed-message", [])],
      } as never,
    );
    const messages = [
      hostMessage("lifecycle-session", "read-call-message", [read]),
      hostMessage("lifecycle-session", "edit-call-message", [edit]),
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

  it("keeps a previously sent fresh Read exact after a later write", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
    });
    const original = lines("fresh source", 80).join("\n");
    const firstRead = lifecycleTool(
      "Read",
      "fresh-read",
      "src/fresh.ts",
      original,
    );
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          hostMessage(
            "lifecycle-session",
            "fresh-read-message",
            [firstRead],
          ),
        ],
      } as never,
    );

    const replayedRead = lifecycleTool(
      "Read",
      "fresh-read",
      "src/fresh.ts",
      original,
    );
    const laterEdit = lifecycleTool(
      "Edit",
      "fresh-edit",
      "src/fresh.ts",
      "Done",
    );
    const messages = [
      hostMessage(
        "lifecycle-session",
        "fresh-read-message",
        [replayedRead],
      ),
      hostMessage(
        "lifecycle-session",
        "fresh-edit-message",
        [laterEdit],
      ),
    ];

    await plugin["experimental.chat.messages.transform"]!(
      {},
      { messages } as never,
    );

    expect(replayedRead.state.output).toBe(original);
  });

  it("forgets sent representations when the owning session is deleted", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
    });
    const original = lines("deletable source", 80).join("\n");
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [hostMessage("deletable-session", "seed", [])],
      } as never,
    );
    const read = lifecycleTool(
      "Read",
      "delete-read",
      "src/delete.ts",
      original,
    );
    read.sessionID = "deletable-session";
    const edit = lifecycleTool(
      "Edit",
      "delete-edit",
      "src/delete.ts",
      "Done",
    );
    edit.sessionID = "deletable-session";
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          hostMessage("deletable-session", "delete-read-message", [read]),
          hostMessage("deletable-session", "delete-edit-message", [edit]),
        ],
      } as never,
    );
    expect(read.state.output).toContain("is stale after a later write");

    await plugin.event!({
      event: {
        type: "session.deleted",
        properties: { info: { id: "deletable-session" } },
      },
    } as never);
    const reloadedRead = lifecycleTool(
      "Read",
      "delete-read",
      "src/delete.ts",
      original,
    );
    reloadedRead.sessionID = "deletable-session";
    const reloadedEdit = lifecycleTool(
      "Edit",
      "delete-edit",
      "src/delete.ts",
      "Done",
    );
    reloadedEdit.sessionID = "deletable-session";
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          hostMessage(
            "deletable-session",
            "delete-read-message",
            [reloadedRead],
          ),
          hostMessage(
            "deletable-session",
            "delete-edit-message",
            [reloadedEdit],
          ),
        ],
      } as never,
    );

    expect(reloadedRead.state.output).toBe(original);
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
