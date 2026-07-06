import { describe, expect, it } from "vitest";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { createRetrieveTool } from "../src/tools/retrieve.js";
import { createStatsTool } from "../src/tools/stats.js";

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
