import { describe, expect, it } from "vitest";

import { containsCCRMarker } from "../src/markers.js";
import { HeadroomNativePlugin } from "../src/plugin.js";
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

function completedToolPart(input: {
  sessionID: string;
  messageID: string;
  callID: string;
  tool: string;
  output: string;
}) {
  return {
    id: `${input.callID}-part`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: input.callID,
    tool: input.tool,
    type: "tool",
    state: {
      status: "completed",
      input: { query: "auth" },
      output: input.output,
      title: "",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

describe("MCP message-transform fallback", () => {
  it("compresses only the pending request-local tool and replays it after pending state is consumed", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const sessionID = "mcp-fallback-session";
    const callID = "mcp-call-1";
    const tool = "context7_search";
    const original = searchFixture();
    const rawCallToolResult = {
      content: [{ type: "text" as const, text: original }],
    };

    // The initial user request establishes the session lifecycle before the
    // MCP result exists. The newly completed part is therefore in the next
    // request's mutable live zone.
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "user-message-1", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
        ],
      } as never,
    );

    // OpenCode currently invokes this hook with the MCP SDK's raw
    // CallToolResult, before it assembles the public `output` string.
    await plugin["tool.execute.after"]!(
      {
        tool,
        sessionID,
        callID,
        args: { query: "auth" },
      },
      rawCallToolResult as never,
    );
    expect(rawCallToolResult.content[0]?.text).toBe(original);

    const persistedPart = completedToolPart({
      sessionID,
      messageID: "assistant-message-1",
      callID,
      tool,
      output: original,
    });
    const requestPart = structuredClone(persistedPart);
    const unpendingOriginal = Array.from(
      { length: 120 },
      (_, index) => `custom native result ${index}: unique payload ${index * 17}`,
    ).join("\n");
    const unpendingPart = completedToolPart({
      sessionID,
      messageID: "assistant-message-1",
      callID: "custom-call-1",
      tool: "custom_native_tool",
      output: unpendingOriginal,
    });
    const requestMessages = [
      {
        info: { id: "user-message-1", sessionID },
        parts: [{ type: "text", text: "Find authentication references" }],
      },
      {
        info: { id: "assistant-message-1", sessionID },
        parts: [requestPart, unpendingPart],
      },
    ];

    await plugin["experimental.chat.messages.transform"]!(
      {},
      { messages: requestMessages } as never,
    );

    expect(persistedPart.state.output).toBe(original);
    expect(requestPart.state.output).not.toBe(original);
    expect(requestPart.state.output.length).toBeLessThan(original.length);
    expect(containsCCRMarker(requestPart.state.output)).toBe(true);
    expect(unpendingPart.state.output).toBe(unpendingOriginal);

    const compressed = requestPart.state.output;
    const replayedPart = structuredClone(persistedPart);
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "user-message-1", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
          {
            info: { id: "assistant-message-1", sessionID },
            parts: [replayedPart],
          },
        ],
      } as never,
    );

    expect(replayedPart.state.output).toBe(compressed);
  });

  it("keeps a pending MCP result raw when cache control freezes its tool part", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const sessionID = "frozen-mcp-session";
    const callID = "frozen-mcp-call";
    const tool = "context7_search";
    const original = searchFixture();

    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "frozen-user-message", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
        ],
      } as never,
    );
    await plugin["tool.execute.after"]!(
      { tool, sessionID, callID, args: { query: "auth" } },
      { content: [{ type: "text", text: original }] } as never,
    );

    const frozenPart = completedToolPart({
      sessionID,
      messageID: "frozen-assistant-message",
      callID,
      tool,
      output: original,
    });
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "frozen-user-message", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
          {
            info: {
              id: "frozen-assistant-message",
              sessionID,
              metadata: { cache_control: { type: "ephemeral" } },
            },
            parts: [frozenPart],
          },
        ],
      } as never,
    );

    expect(frozenPart.state.output).toBe(original);
    expect(containsCCRMarker(frozenPart.state.output)).toBe(false);
  });

  it("does not compress an already assembled after-hook result again during transform", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const sessionID = "assembled-mcp-session";
    const callID = "assembled-mcp-call";
    const tool = "context7_search";

    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "assembled-user-message", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
        ],
      } as never,
    );

    const assembled = {
      title: tool,
      output: searchFixture(),
      metadata: {} as Record<string, unknown>,
    };
    await plugin["tool.execute.after"]!(
      { tool, sessionID, callID, args: { query: "auth" } },
      assembled,
    );
    expect(containsCCRMarker(assembled.output)).toBe(true);

    const requestPart = completedToolPart({
      sessionID,
      messageID: "assembled-assistant-message",
      callID,
      tool,
      output: assembled.output,
    });
    const afterHookOutput = assembled.output;
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "assembled-user-message", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
          {
            info: { id: "assembled-assistant-message", sessionID },
            parts: [requestPart],
          },
        ],
      } as never,
    );

    expect(requestPart.state.output).toBe(afterHookOutput);
  });

  it("clears pending MCP identities when the session is deleted", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const sessionID = "deleted-mcp-session";
    const callID = "deleted-mcp-call";
    const tool = "context7_search";
    const original = searchFixture();

    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "deleted-user-before", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
        ],
      } as never,
    );
    await plugin["tool.execute.after"]!(
      { tool, sessionID, callID, args: { query: "auth" } },
      { content: [{ type: "text", text: original }] } as never,
    );
    await plugin.event!({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionID } },
      },
    } as never);

    // Re-establish the lifecycle after deletion. Reusing the old identity
    // without another raw hook must not revive the discarded pending entry.
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "deleted-user-after", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
        ],
      } as never,
    );
    const requestPart = completedToolPart({
      sessionID,
      messageID: "deleted-assistant-after",
      callID,
      tool,
      output: original,
    });
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "deleted-user-after", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
          {
            info: { id: "deleted-assistant-after", sessionID },
            parts: [requestPart],
          },
        ],
      } as never,
    );

    expect(requestPart.state.output).toBe(original);
  });

  it("processes multiple pending MCP results sequentially", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const sessionID = "ordered-mcp-session";
    const tool = "context7_search";
    const original = searchFixture();

    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "ordered-user", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
        ],
      } as never,
    );
    for (const callID of ["ordered-call-1", "ordered-call-2"]) {
      await plugin["tool.execute.after"]!(
        { tool, sessionID, callID, args: { query: "auth" } },
        { content: [{ type: "text", text: original }] } as never,
      );
    }

    const first = completedToolPart({
      sessionID,
      messageID: "ordered-assistant",
      callID: "ordered-call-1",
      tool,
      output: original,
    });
    const second = completedToolPart({
      sessionID,
      messageID: "ordered-assistant",
      callID: "ordered-call-2",
      tool,
      output: original,
    });
    await plugin["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id: "ordered-user", sessionID },
            parts: [{ type: "text", text: "Find authentication references" }],
          },
          {
            info: { id: "ordered-assistant", sessionID },
            parts: [first, second],
          },
        ],
      } as never,
    );

    expect(containsCCRMarker(first.state.output)).toBe(true);
    expect(second.state.output).toContain(
      "[Repeated tool output: exact match to an earlier result in this session]",
    );
    expect(containsCCRMarker(second.state.output)).toBe(true);
  });
});
