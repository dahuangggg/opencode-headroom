import { describe, expect, it } from "vitest";

import { ContextLifecycleManager } from "../src/session/context-lifecycle.js";

function completedTool(input: {
  sessionID: string;
  callID?: string;
  partID?: string;
  messageID?: string;
  output?: string;
  cacheControl?: boolean;
}) {
  return {
    type: "tool",
    ...(input.partID ? { id: input.partID } : {}),
    ...(input.callID ? { callID: input.callID } : {}),
    ...(input.messageID ? { messageID: input.messageID } : {}),
    sessionID: input.sessionID,
    metadata: input.cacheControl
      ? { cache_control: { type: "ephemeral" } }
      : {},
    state: {
      status: "completed",
      input: {},
      output: input.output ?? "tool output",
      title: "Tool",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function runningTool(input: {
  sessionID: string;
  callID: string;
  partID: string;
  messageID: string;
}) {
  return {
    type: "tool",
    id: input.partID,
    callID: input.callID,
    messageID: input.messageID,
    sessionID: input.sessionID,
    state: {
      status: "running",
      input: {},
      title: "Tool",
      metadata: {},
      time: { start: 1 },
    },
  };
}

function message(
  id: string,
  sessionID: string,
  parts: readonly unknown[],
) {
  return {
    info: { id, sessionID, role: "assistant" },
    parts,
  };
}

describe("Context lifecycle", () => {
  it("rejects invalid bounds", () => {
    expect(
      () => new ContextLifecycleManager({ maxSessions: 0 }),
    ).toThrow(/maxSessions must be a positive safe integer/);
    expect(
      () => new ContextLifecycleManager({ maxPartsPerSession: 0 }),
    ).toThrow(/maxPartsPerSession must be a positive safe integer/);
    expect(
      () =>
        new ContextLifecycleManager({ maxRepresentationCharsPerSession: 0 }),
    ).toThrow(/maxRepresentationCharsPerSession must be a positive safe integer/);
  });

  it("freezes every completed tool part on first session observation", () => {
    const manager = new ContextLifecycleManager();
    const first = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
    });

    const window = manager.begin([
      message("message-1", "s1", [first]),
    ]);

    expect(window.canMutateToolPart(first)).toBe(false);
    expect(window.stats).toMatchObject({
      completedToolParts: 1,
      liveToolParts: 0,
      frozenToolParts: 1,
    });
  });

  it("opens only newly completed tool parts on later observations", () => {
    const manager = new ContextLifecycleManager();
    const first = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
    });
    manager.begin([message("message-1", "s1", [first])]).commit();

    const replayed = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
    });
    const appended = completedTool({
      sessionID: "s1",
      callID: "call-2",
      partID: "part-2",
      messageID: "message-2",
    });
    const window = manager.begin([
      message("message-1", "s1", [replayed]),
      message("message-2", "s1", [appended]),
    ]);

    expect(window.canMutateToolPart(replayed)).toBe(false);
    expect(window.canMutateToolPart(appended)).toBe(true);
    expect(window.stats).toMatchObject({
      completedToolParts: 2,
      liveToolParts: 1,
      frozenToolParts: 1,
    });
  });

  it("treats a newly completed part in an existing message as live", () => {
    const manager = new ContextLifecycleManager();
    const running = runningTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
    });
    manager.begin([message("message-1", "s1", [running])]).commit();

    const completed = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
    });
    const window = manager.begin([
      message("message-1", "s1", [completed]),
    ]);

    expect(window.canMutateToolPart(completed)).toBe(true);
  });

  it("uses explicit cache control to expand the frozen prefix", () => {
    const manager = new ContextLifecycleManager();
    manager.begin([message("seed", "s1", [])]).commit();
    const beforeBreakpoint = completedTool({
      sessionID: "s1",
      callID: "before",
      partID: "before-part",
      messageID: "message-1",
    });
    const breakpoint = completedTool({
      sessionID: "s1",
      callID: "breakpoint",
      partID: "breakpoint-part",
      messageID: "message-2",
      cacheControl: true,
    });
    const afterBreakpoint = completedTool({
      sessionID: "s1",
      callID: "after",
      partID: "after-part",
      messageID: "message-3",
    });

    const window = manager.begin([
      message("message-1", "s1", [beforeBreakpoint]),
      message("message-2", "s1", [breakpoint]),
      message("message-3", "s1", [afterBreakpoint]),
    ]);

    expect(window.canMutateToolPart(beforeBreakpoint)).toBe(false);
    expect(window.canMutateToolPart(breakpoint)).toBe(false);
    expect(window.canMutateToolPart(afterBreakpoint)).toBe(true);
  });

  it("fails closed for missing identities and saturated session state", () => {
    const manager = new ContextLifecycleManager({ maxPartsPerSession: 1 });
    manager.begin([message("seed", "s1", [])]).commit();
    const missingIdentity = completedTool({ sessionID: "s1" });
    const first = completedTool({ sessionID: "s1", callID: "first" });
    const overflow = completedTool({ sessionID: "s1", callID: "overflow" });

    const window = manager.begin([
      message("message-1", "s1", [missingIdentity, first, overflow]),
    ]);

    expect(window.canMutateToolPart(missingIdentity)).toBe(false);
    expect(window.canMutateToolPart(first)).toBe(false);
    expect(window.canMutateToolPart(overflow)).toBe(false);
    expect(window.stats.saturatedSessions).toBe(1);
  });

  it("isolates sessions and resets a deleted session to conservative seeding", () => {
    const manager = new ContextLifecycleManager({ maxSessions: 2 });
    const s1First = completedTool({ sessionID: "s1", callID: "shared" });
    const s2First = completedTool({ sessionID: "s2", callID: "shared" });
    manager.begin([message("s1-message", "s1", [s1First])]).commit();
    manager.begin([message("s2-message", "s2", [s2First])]).commit();

    const s1Appended = completedTool({ sessionID: "s1", callID: "new" });
    expect(
      manager
        .begin([
          message("s1-message", "s1", [s1First]),
          message("s1-new", "s1", [s1Appended]),
        ])
        .canMutateToolPart(s1Appended),
    ).toBe(true);

    manager.deleteSession("s1");
    const afterDelete = completedTool({ sessionID: "s1", callID: "new" });
    expect(
      manager
        .begin([message("s1-new", "s1", [afterDelete])])
        .canMutateToolPart(afterDelete),
    ).toBe(false);
    expect(manager.sessionCount).toBe(2);

    manager.clear();
    expect(manager.sessionCount).toBe(0);
  });

  it("replays the exact representation sent for a transformed live part", () => {
    const manager = new ContextLifecycleManager();
    manager.begin([message("seed", "s1", [])]).commit();
    const raw = "raw tool output that OpenCode reloads from storage";
    const live = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    const liveWindow = manager.begin([
      message("message-1", "s1", [live]),
    ]);
    expect(liveWindow.canMutateToolPart(live)).toBe(true);
    live.state.output = "[compressed representation hash=abc123]";
    liveWindow.commit();

    const reloaded = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    const frozenWindow = manager.begin([
      message("message-1", "s1", [reloaded]),
    ]);

    expect(frozenWindow.canMutateToolPart(reloaded)).toBe(false);
    expect(reloaded.state.output).toBe("[compressed representation hash=abc123]");
    expect(frozenWindow.stats.replayedToolParts).toBe(1);
  });

  it("rolls back a live mutation that cannot be retained for exact replay", () => {
    const manager = new ContextLifecycleManager({
      maxRepresentationCharsPerSession: 16,
    });
    manager.begin([message("seed", "s1", [])]).commit();
    const raw = "original output";
    const live = completedTool({
      sessionID: "s1",
      callID: "call-1",
      output: raw,
    });
    const window = manager.begin([message("message-1", "s1", [live])]);
    live.state.output = "a transformed representation larger than the budget";

    window.commit();

    expect(live.state.output).toBe(raw);
    expect(window.stats.rolledBackToolParts).toBe(1);
  });
});
