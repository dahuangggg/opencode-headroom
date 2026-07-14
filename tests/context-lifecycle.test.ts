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
    const first = completedTool({
      sessionID: "s1",
      callID: "first",
      partID: "first-part",
      messageID: "message-1",
    });
    const overflow = completedTool({
      sessionID: "s1",
      callID: "overflow",
      partID: "overflow-part",
      messageID: "message-1",
    });

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
    const s1First = completedTool({
      sessionID: "s1",
      callID: "shared",
      partID: "s1-shared-part",
      messageID: "s1-message",
    });
    const s2First = completedTool({
      sessionID: "s2",
      callID: "shared",
      partID: "s2-shared-part",
      messageID: "s2-message",
    });
    manager.begin([message("s1-message", "s1", [s1First])]).commit();
    manager.begin([message("s2-message", "s2", [s2First])]).commit();

    const s1Appended = completedTool({
      sessionID: "s1",
      callID: "new",
      partID: "s1-new-part",
      messageID: "s1-new",
    });
    expect(
      manager
        .begin([
          message("s1-message", "s1", [s1First]),
          message("s1-new", "s1", [s1Appended]),
        ])
        .canMutateToolPart(s1Appended),
    ).toBe(true);

    manager.deleteSession("s1");
    const afterDelete = completedTool({
      sessionID: "s1",
      callID: "new",
      partID: "s1-new-part",
      messageID: "s1-new",
    });
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
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    const window = manager.begin([message("message-1", "s1", [live])]);
    live.state.output = "a transformed representation larger than the budget";

    window.commit();

    expect(live.state.output).toBe(raw);
    expect(window.stats.rolledBackToolParts).toBe(1);
  });

  it("does not evict a session whose changed representation must be replayed", () => {
    const manager = new ContextLifecycleManager({ maxSessions: 1 });
    manager.begin([message("seed-1", "s1", [])]).commit();
    const raw = "raw output retained by OpenCode";
    const live = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    const liveWindow = manager.begin([message("message-1", "s1", [live])]);
    live.state.output = "[compressed]";
    liveWindow.commit();

    manager.begin([message("seed-2", "s2", [])]).commit();

    const reloaded = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    const replayWindow = manager.begin([
      message("message-1", "s1", [reloaded]),
    ]);

    expect(manager.sessionCount).toBe(1);
    expect(reloaded.state.output).toBe("[compressed]");
    expect(replayWindow.stats.replayedToolParts).toBe(1);
  });

  it("does not let mismatched part identities initialize another session", () => {
    const manager = new ContextLifecycleManager();
    const mismatched = completedTool({
      sessionID: "s2",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-s2",
    });
    manager.begin([message("message-s1", "s1", [mismatched])]).commit();

    const legitimate = completedTool({
      sessionID: "s2",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-s2",
    });
    const firstS2Window = manager.begin([
      message("message-s2", "s2", [legitimate]),
    ]);

    expect(firstS2Window.canMutateToolPart(legitimate)).toBe(false);
  });

  it("requires the complete OpenCode tool identity", () => {
    const manager = new ContextLifecycleManager();
    manager.begin([message("seed", "s1", [])]).commit();
    const missingPartID = completedTool({
      sessionID: "s1",
      callID: "call-1",
      messageID: "message-1",
    });
    const missingCallID = completedTool({
      sessionID: "s1",
      partID: "part-2",
      messageID: "message-1",
    });
    const window = manager.begin([
      message("message-1", "s1", [missingPartID, missingCallID]),
    ]);

    expect(window.canMutateToolPart(missingPartID)).toBe(false);
    expect(window.canMutateToolPart(missingCallID)).toBe(false);
    expect(window.stats.unidentifiedToolParts).toBe(2);
  });

  it("scopes a tool identity to its owning message", () => {
    const manager = new ContextLifecycleManager();
    manager.begin([message("seed", "s1", [])]).commit();
    const first = completedTool({
      sessionID: "s1",
      callID: "shared-call",
      partID: "shared-part",
      messageID: "message-1",
      output: "first raw",
    });
    const firstWindow = manager.begin([
      message("message-1", "s1", [first]),
    ]);
    first.state.output = "first sent";
    firstWindow.commit();

    const second = completedTool({
      sessionID: "s1",
      callID: "shared-call",
      partID: "shared-part",
      messageID: "message-2",
      output: "second raw",
    });
    const secondWindow = manager.begin([
      message("message-2", "s1", [second]),
    ]);

    expect(second.state.output).toBe("second raw");
    expect(secondWindow.canMutateToolPart(second)).toBe(true);
  });

  it("replays an intentionally empty changed representation", () => {
    const manager = new ContextLifecycleManager();
    manager.begin([message("seed", "s1", [])]).commit();
    const raw = "raw output";
    const live = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    const liveWindow = manager.begin([message("message-1", "s1", [live])]);
    live.state.output = "";
    liveWindow.commit();

    const reloaded = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    const replayWindow = manager.begin([
      message("message-1", "s1", [reloaded]),
    ]);

    expect(reloaded.state.output).toBe("");
    expect(replayWindow.stats.replayedToolParts).toBe(1);
  });

  it("serializes overlapping transforms for the same session", async () => {
    const manager = new ContextLifecycleManager();
    manager.begin([message("seed", "s1", [])]).commit();
    const raw = "raw output";
    const first = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });

    const firstTransform = manager.run(
      [message("message-1", "s1", [first])],
      async (window) => {
        expect(window.canMutateToolPart(first)).toBe(true);
        first.state.output = "[compressed]";
        markFirstEntered();
        await firstGate;
      },
    );
    await firstEntered;

    const reloaded = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    let secondEntered = false;
    const secondTransform = manager.run(
      [message("message-1", "s1", [reloaded])],
      async (window) => {
        secondEntered = true;
        expect(window.canMutateToolPart(reloaded)).toBe(false);
        expect(reloaded.state.output).toBe("[compressed]");
      },
    );
    await Promise.resolve();
    expect(secondEntered).toBe(false);

    releaseFirst();
    await Promise.all([firstTransform, secondTransform]);
    expect(secondEntered).toBe(true);
  });

  it("rolls back both direct windows when they overlap", () => {
    const manager = new ContextLifecycleManager();
    manager.begin([message("seed", "s1", [])]).commit();
    const raw = "raw output";
    const first = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    const firstWindow = manager.begin([
      message("message-1", "s1", [first]),
    ]);
    first.state.output = "first sent";
    const second = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: raw,
    });
    const secondWindow = manager.begin([
      message("message-1", "s1", [second]),
    ]);

    firstWindow.commit();
    secondWindow.commit();

    expect(first.state.output).toBe(raw);
    expect(second.state.output).toBe(raw);
  });

  it("does not let an old window charge a recreated session", () => {
    const manager = new ContextLifecycleManager({
      maxRepresentationCharsPerSession: 3,
    });
    manager.begin([message("seed", "s1", [])]).commit();
    const stale = completedTool({
      sessionID: "s1",
      callID: "stale",
      partID: "stale-part",
      messageID: "stale-message",
      output: "raw stale",
    });
    const staleWindow = manager.begin([
      message("stale-message", "s1", [stale]),
    ]);
    stale.state.output = "aa";

    manager.deleteSession("s1");
    manager.begin([message("new-seed", "s1", [])]).commit();
    staleWindow.commit();

    const current = completedTool({
      sessionID: "s1",
      callID: "current",
      partID: "current-part",
      messageID: "current-message",
      output: "raw current",
    });
    const currentWindow = manager.begin([
      message("current-message", "s1", [current]),
    ]);
    current.state.output = "bb";
    currentWindow.commit();

    expect(stale.state.output).toBe("raw stale");
    expect(current.state.output).toBe("bb");
    expect(currentWindow.stats.rolledBackToolParts).toBe(0);
  });

  it("aborts live mutations when a transform throws", async () => {
    const manager = new ContextLifecycleManager();
    manager.begin([message("seed", "s1", [])]).commit();
    const live = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: "raw output",
    });

    await expect(
      manager.run([message("message-1", "s1", [live])], async () => {
        live.state.output = "partial mutation";
        throw new Error("transform failed");
      }),
    ).rejects.toThrow("transform failed");
    expect(live.state.output).toBe("raw output");

    const reloaded = completedTool({
      sessionID: "s1",
      callID: "call-1",
      partID: "part-1",
      messageID: "message-1",
      output: "raw output",
    });
    const window = manager.begin([
      message("message-1", "s1", [reloaded]),
    ]);
    expect(reloaded.state.output).toBe("raw output");
    expect(window.stats.replayedToolParts).toBe(0);
  });

  it("waits for an in-flight transform before session cleanup", async () => {
    const manager = new ContextLifecycleManager();
    let releaseTransform!: () => void;
    const transformGate = new Promise<void>((resolve) => {
      releaseTransform = resolve;
    });
    let markTransformEntered!: () => void;
    const transformEntered = new Promise<void>((resolve) => {
      markTransformEntered = resolve;
    });
    const transform = manager.run(
      [message("message-1", "s1", [])],
      async () => {
        markTransformEntered();
        await transformGate;
      },
    );
    await transformEntered;

    let cleanupEntered = false;
    const cleanup = manager.runSessionExclusive("s1", async () => {
      cleanupEntered = true;
      manager.deleteSession("s1");
    });
    await Promise.resolve();
    expect(cleanupEntered).toBe(false);

    releaseTransform();
    await Promise.all([transform, cleanup]);
    expect(cleanupEntered).toBe(true);
    expect(manager.sessionCount).toBe(0);
  });

  it("bounds active session queues and skips an untracked overflow transform", async () => {
    const manager = new ContextLifecycleManager({ maxSessions: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let markBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      markBothEntered = resolve;
    });
    const hold = (sessionID: string) =>
      manager.run([message("message-1", sessionID, [])], async () => {
        entered += 1;
        if (entered === 2) markBothEntered();
        await gate;
      });
    const first = hold("s1");
    const second = hold("s2");
    await bothEntered;
    expect(manager.activeTransformSessionCount).toBe(2);

    let overflowCalled = false;
    await expect(
      manager.run([message("message-1", "s3", [])], async () => {
        overflowCalled = true;
      }),
    ).rejects.toThrow(/capacity unavailable/);
    expect(overflowCalled).toBe(false);
    expect(manager.activeTransformSessionCount).toBe(2);

    release();
    await Promise.all([first, second]);
    expect(manager.activeTransformSessionCount).toBe(0);
  });

  it("drains active transforms and rejects new work while closing", async () => {
    const manager = new ContextLifecycleManager();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const active = manager.run(
      [message("message-1", "s1", [])],
      async () => {
        markEntered();
        await gate;
      },
    );
    await entered;
    let drained = false;
    const closing = manager.closeAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(
      manager.run([message("message-1", "s2", [])], async () => {}),
    ).rejects.toThrow(/closing/);

    release();
    await Promise.all([active, closing]);
    expect(drained).toBe(true);
    expect(manager.activeTransformSessionCount).toBe(0);
  });

  it("lets already queued cleanup finish when disposal starts in the same tick", async () => {
    const manager = new ContextLifecycleManager();
    let cleanupRan = false;
    const cleanup = manager.runSessionExclusive("s1", async () => {
      cleanupRan = true;
      manager.deleteSession("s1");
    });
    const closing = manager.closeAndDrain();

    await expect(Promise.all([cleanup, closing])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(cleanupRan).toBe(true);
  });
});
