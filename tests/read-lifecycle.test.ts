import { describe, expect, it, vi } from "vitest";

import { ReadLifecycleManager } from "../src/session/read-lifecycle.js";
import { MemoryCCRStore } from "../src/store/memory.js";

function largeRead(label: string): string {
  return Array.from(
    { length: 80 },
    (_, index) => `${index + 1}: ${label} source line ${index + 1}`,
  ).join("\n");
}

function completedTool(input: {
  tool: string;
  callID: string;
  filePath: string;
  output: string;
  offset?: number;
  limit?: number;
  cacheControl?: boolean;
}) {
  return {
    type: "tool",
    tool: input.tool,
    sessionID: "read-session",
    callID: input.callID,
    metadata: input.cacheControl ? { cache_control: { type: "ephemeral" } } : {},
    state: {
      status: "completed",
      input: {
        filePath: input.filePath,
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      output: input.output,
      title: input.tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function outputOf(part: ReturnType<typeof completedTool>): string {
  return part.state.output;
}

describe("Read lifecycle", () => {
  it("rejects invalid lifecycle bounds at initialization", () => {
    const store = new MemoryCCRStore();

    expect(
      () =>
        new ReadLifecycleManager(store, {
          basePath: "/repo",
          ttlMs: 60_000,
          maxOperations: 0,
        }),
    ).toThrow(/maxOperations must be a positive safe integer/);
  });

  it("replaces a Read made stale by a later edit and stores the exact original", async () => {
    const store = new MemoryCCRStore();
    const original = largeRead("before edit");
    const read = completedTool({
      tool: "Read",
      callID: "read-1",
      filePath: "src/auth.ts",
      output: original,
    });
    const edit = completedTool({
      tool: "Edit",
      callID: "edit-1",
      filePath: "./src/auth.ts",
      output: "Done",
    });
    const messages = [
      { info: {}, parts: [read] },
      { info: {}, parts: [edit] },
    ];

    const manager = new ReadLifecycleManager(store, {
      basePath: "/repo",
      ttlMs: 60_000,
    });
    const stats = await manager.apply(messages);

    expect(outputOf(read)).toMatch(
      /^\[Read of src\/auth\.ts is stale after a later write\./,
    );
    expect(outputOf(edit)).toBe("Done");
    expect(stats).toMatchObject({
      readsTotal: 1,
      readsStale: 1,
      readsSuperseded: 0,
      replacementsApplied: 1,
    });
    const hash = outputOf(read).match(/hash=([0-9a-f]{24})/)?.[1];
    expect(hash).toBeDefined();
    expect((await store.get(hash!, "read-session"))?.originalContent).toBe(
      original,
    );
  });

  it("replaces only an earlier Read fully covered by a later Read", async () => {
    const store = new MemoryCCRStore();
    const covered = completedTool({
      tool: "Read",
      callID: "read-covered",
      filePath: "src/ranges.ts",
      offset: 20,
      limit: 10,
      output: largeRead("covered range"),
    });
    const covering = completedTool({
      tool: "Read",
      callID: "read-covering",
      filePath: "src/ranges.ts",
      offset: 10,
      limit: 30,
      output: largeRead("covering range"),
    });
    const messages = [
      { info: {}, parts: [covered] },
      { info: {}, parts: [covering] },
    ];

    const manager = new ReadLifecycleManager(store, {
      basePath: "/repo",
      ttlMs: 60_000,
    });
    const stats = await manager.apply(messages);

    expect(outputOf(covered)).toContain("is superseded by a later Read");
    expect(outputOf(covering)).toBe(largeRead("covering range"));
    expect(stats).toMatchObject({
      readsTotal: 2,
      readsStale: 0,
      readsSuperseded: 1,
      replacementsApplied: 1,
    });
  });

  it("keeps overlapping partial Reads when the later range is not a superset", async () => {
    const store = new MemoryCCRStore();
    const earlier = completedTool({
      tool: "Read",
      callID: "read-earlier",
      filePath: "src/partial.ts",
      offset: 10,
      limit: 30,
      output: largeRead("earlier partial"),
    });
    const later = completedTool({
      tool: "Read",
      callID: "read-later",
      filePath: "src/partial.ts",
      offset: 20,
      limit: 30,
      output: largeRead("later partial"),
    });
    const messages = [
      { info: {}, parts: [earlier] },
      { info: {}, parts: [later] },
    ];

    const manager = new ReadLifecycleManager(store, {
      basePath: "/repo",
      ttlMs: 60_000,
    });
    const stats = await manager.apply(messages);

    expect(outputOf(earlier)).toBe(largeRead("earlier partial"));
    expect(outputOf(later)).toBe(largeRead("later partial"));
    expect(stats.replacementsApplied).toBe(0);
  });

  it("keeps the entire cache-controlled prefix byte-exact", async () => {
    const store = new MemoryCCRStore();
    const original = largeRead("cached source");
    const read = completedTool({
      tool: "Read",
      callID: "read-cached",
      filePath: "src/cached.ts",
      output: original,
    });
    const cacheBreakpoint = completedTool({
      tool: "Bash",
      callID: "cache-breakpoint",
      filePath: "ignored",
      output: "checkpoint",
      cacheControl: true,
    });
    const edit = completedTool({
      tool: "Write",
      callID: "write-after-cache",
      filePath: "src/cached.ts",
      output: "Done",
    });
    const messages = [
      { info: {}, parts: [read] },
      { info: {}, parts: [cacheBreakpoint] },
      { info: {}, parts: [edit] },
    ];

    const manager = new ReadLifecycleManager(store, {
      basePath: "/repo",
      ttlMs: 60_000,
    });
    const stats = await manager.apply(messages);

    expect(outputOf(read)).toBe(original);
    expect(stats).toMatchObject({
      readsStale: 1,
      replacementsApplied: 0,
      frozenReadsSkipped: 1,
    });
  });

  it("replays the same marker without creating duplicate CCR entries", async () => {
    const store = new MemoryCCRStore();
    const manager = new ReadLifecycleManager(store, {
      basePath: "/repo",
      ttlMs: 60_000,
    });
    const makeMessages = () => {
      const read = completedTool({
        tool: "Read",
        callID: "stable-read",
        filePath: "src/stable.ts",
        output: largeRead("stable original"),
      });
      const edit = completedTool({
        tool: "Edit",
        callID: "stable-edit",
        filePath: "src/stable.ts",
        output: "Done",
      });
      return { read, messages: [{ info: {}, parts: [read] }, { info: {}, parts: [edit] }] };
    };

    const first = makeMessages();
    const second = makeMessages();
    await manager.apply(first.messages);
    await manager.apply(second.messages);

    expect(outputOf(second.read)).toBe(outputOf(first.read));
    expect((await store.stats("read-session")).entryCount).toBe(1);
    expect(manager.replacementCount).toBe(1);
    manager.deleteSession("read-session");
    expect(manager.replacementCount).toBe(0);
  });

  it("fails open when CCR storage is unavailable", async () => {
    const store = new MemoryCCRStore();
    vi.spyOn(store, "put").mockRejectedValue(new Error("storage unavailable"));
    const manager = new ReadLifecycleManager(store, {
      basePath: "/repo",
      ttlMs: 60_000,
    });
    const original = largeRead("must survive");
    const read = completedTool({
      tool: "Read",
      callID: "failed-read",
      filePath: "src/fail-open.ts",
      output: original,
    });
    const edit = completedTool({
      tool: "Edit",
      callID: "failed-edit",
      filePath: "src/fail-open.ts",
      output: "Done",
    });

    const stats = await manager.apply([
      { info: {}, parts: [read] },
      { info: {}, parts: [edit] },
    ]);

    expect(outputOf(read)).toBe(original);
    expect(stats.replacementsApplied).toBe(0);
  });

  it("removes invisible control characters from marker paths", async () => {
    const store = new MemoryCCRStore();
    const manager = new ReadLifecycleManager(store, {
      basePath: "/repo",
      ttlMs: 60_000,
    });
    const hostilePath = "src/\u001b[31mhidden\u202E.ts";
    const read = completedTool({
      tool: "Read",
      callID: "hostile-read",
      filePath: hostilePath,
      output: largeRead("hostile path source"),
    });
    const edit = completedTool({
      tool: "Edit",
      callID: "hostile-edit",
      filePath: hostilePath,
      output: "Done",
    });

    await manager.apply([
      { info: {}, parts: [read] },
      { info: {}, parts: [edit] },
    ]);

    expect(outputOf(read)).toContain("Retrieve original: hash=");
    expect(outputOf(read)).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
  });

  it("fails open when the bounded operation scan overflows", async () => {
    const store = new MemoryCCRStore();
    const manager = new ReadLifecycleManager(store, {
      basePath: "/repo",
      ttlMs: 60_000,
      maxOperations: 1,
    });
    const original = largeRead("overflow source");
    const read = completedTool({
      tool: "Read",
      callID: "overflow-read",
      filePath: "src/overflow.ts",
      output: original,
    });
    const edit = completedTool({
      tool: "Edit",
      callID: "overflow-edit",
      filePath: "src/overflow.ts",
      output: "Done",
    });

    const stats = await manager.apply([
      { info: {}, parts: [read] },
      { info: {}, parts: [edit] },
    ]);

    expect(outputOf(read)).toBe(original);
    expect(stats.operationsOverflowed).toBe(true);
    expect((await store.stats()).entryCount).toBe(0);
  });
});
