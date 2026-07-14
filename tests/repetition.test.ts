import { describe, expect, it } from "vitest";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { SessionRepetitionStore } from "../src/session/repetition.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { searchFixture } from "./fixtures.js";

function compressionInput(
  output: string,
  sessionID = "s1",
  callID = "c1",
) {
  return {
    tool: "Bash",
    sessionID,
    callID,
    args: { command: "rg auth" },
    output,
    ttlMs: 60_000,
  };
}

describe("session repetition store", () => {
  it("matches exact and highly similar output only inside one session", () => {
    const state = new SessionRepetitionStore();
    const original = searchFixture();
    const similar = original.replace(
      "src/auth.ts:2:auth event 2",
      "src/auth.ts:2:auth event changed",
    );

    state.record("s1", "111111111111111111111111", original);

    expect(state.match("s1", original)).toMatchObject({
      hash: "111111111111111111111111",
      kind: "exact",
      similarity: 1,
    });
    expect(state.match("s1", similar)).toMatchObject({
      hash: "111111111111111111111111",
      kind: "similar",
    });
    expect(state.match("s2", original)).toBeUndefined();
  });

  it("bounds sessions and entries and deletes lifecycle state", () => {
    const state = new SessionRepetitionStore({
      maxSessions: 2,
      maxEntriesPerSession: 2,
    });
    const content = (label: string) =>
      Array.from({ length: 20 }, (_, index) => `${label} line ${index}`).join("\n");

    state.record("s1", "111111111111111111111111", content("one"));
    state.record("s1", "222222222222222222222222", content("two"));
    state.record("s1", "333333333333333333333333", content("three"));
    expect(state.match("s1", content("one"))).toBeUndefined();
    expect(state.entryCount("s1")).toBe(2);

    state.record("s2", "444444444444444444444444", content("four"));
    state.record("s3", "555555555555555555555555", content("five"));
    expect(state.match("s1", content("three"))).toBeUndefined();
    expect(state.sessionCount).toBe(2);

    state.delete("s2");
    expect(state.match("s2", content("four"))).toBeUndefined();
    state.clear();
    expect(state.sessionCount).toBe(0);
  });

  it("does not match state past the owning CCR lifetime", () => {
    const state = new SessionRepetitionStore();
    const original = searchFixture();
    state.record("s1", "111111111111111111111111", original, 10_000);

    expect(state.match("s1", original, 9_999)?.kind).toBe("exact");
    expect(state.match("s1", original, 10_000)).toBeUndefined();
    expect(state.sessionCount).toBe(0);
  });
});

describe("native repetition folding", () => {
  it("stores an exact repeat under a retrievable marker and emits a bounded pointer", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const original = searchFixture();
    const first = await engine.compress(compressionInput(original));
    const repeated = await engine.compress(
      compressionInput(original, "s1", "c2"),
    );

    expect(first.changed).toBe(true);
    expect(repeated.changed).toBe(true);
    expect(repeated.strategy).toBe("repetition");
    expect(repeated.output).toContain("exact match to an earlier result");
    expect(repeated.output).toContain(`[Retrieve more: hash=${repeated.hash}]`);
    expect(repeated.output.length).toBeLessThan(240);
    expect(
      await engine.retrieve(repeated.hash!, { mode: "full" }, "s1"),
    ).toEqual({ found: true, output: original });
  });

  it("folds a highly similar repeat but never folds across sessions", async () => {
    const engine = new NativeHeadroomCompatibleEngine(new MemoryCCRStore());
    const original = searchFixture();
    const similar = original.replace(
      "src/auth.ts:2:auth event 2",
      "src/auth.ts:2:auth event changed",
    );
    await engine.compress(compressionInput(original));

    const otherSession = await engine.compress(
      compressionInput(original, "s2", "c2"),
    );
    const similarResult = await engine.compress(
      compressionInput(similar, "s1", "c3"),
    );

    expect(otherSession.strategy).not.toBe("repetition");
    expect(similarResult.strategy).toBe("repetition");
    expect(similarResult.output).toContain("similar to an earlier result");
    expect(
      await engine.retrieve(similarResult.hash!, { mode: "full" }, "s1"),
    ).toEqual({ found: true, output: similar });
  });

  it("drops repetition state when its session lifecycle ends", async () => {
    const engine = new NativeHeadroomCompatibleEngine(new MemoryCCRStore());
    const original = searchFixture();
    await engine.compress(compressionInput(original));

    engine.deleteSessionState("s1");
    const afterDelete = await engine.compress(
      compressionInput(original, "s1", "c2"),
    );
    expect(afterDelete.strategy).not.toBe("repetition");

    engine.clearSessionState();
    expect(engine.repetitionSessionCount).toBe(0);
  });
});
