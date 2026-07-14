import { describe, expect, it } from "vitest";

import { SessionIntentStore } from "../src/session/intent.js";
import { buildCompressionQuery } from "../src/engine/native.js";

describe("session intent store", () => {
  it("keeps only bounded text from the latest real user message", () => {
    const store = new SessionIntentStore({ maxSessions: 2, maxChars: 12 });

    store.update("session-a", [
      { type: "text", text: "find credential rotation failure" },
      { type: "text", text: "ignored", ignored: true },
    ]);

    expect(store.get("session-a")).toHaveLength(12);
    expect(store.get("session-a")).toContain("find");
  });

  it("bounds sessions and deletes lifecycle state", () => {
    const store = new SessionIntentStore({ maxSessions: 2, maxChars: 100 });
    store.update("session-a", [{ type: "text", text: "alpha" }]);
    store.update("session-b", [{ type: "text", text: "beta" }]);
    store.update("session-c", [{ type: "text", text: "gamma" }]);

    expect(store.get("session-a")).toBeUndefined();
    expect(store.size).toBe(2);

    store.delete("session-b");
    expect(store.get("session-b")).toBeUndefined();
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("compression relevance context", () => {
  it("combines bounded session intent with scalar tool arguments", () => {
    const query = buildCompressionQuery(
      { query: "auth.ts", count: 4, nested: { secret: "must-not-copy" } },
      "find credential rotation failure",
    );

    expect(query).toContain("find credential rotation failure");
    expect(query).toContain("auth.ts 4");
    expect(query).not.toContain("must-not-copy");
    expect(query.length).toBeLessThanOrEqual(2_000);
  });

  it("reserves query space for top-level scalar arguments after a long intent", () => {
    const query = buildCompressionQuery(
      {
        file: "src/security/auth.ts",
        line: 417,
        exact: true,
        nested: { token: "must-not-copy" },
      },
      "investigate authentication failure ".repeat(200),
    );

    expect(query).toContain("src/security/auth.ts 417 true");
    expect(query).not.toContain("must-not-copy");
    expect(query.length).toBeLessThanOrEqual(2_000);
  });

  it("caps the scalar argument contribution at 300 characters", () => {
    const query = buildCompressionQuery(
      { query: "x".repeat(1_000) },
      "i".repeat(3_000),
    );
    const [boundedIntent, boundedArgs] = query.split("\n");

    expect(query).toHaveLength(2_000);
    expect(boundedIntent).toHaveLength(1_699);
    expect(boundedArgs).toHaveLength(300);
  });

  it("does not let one long scalar hide a later active file", () => {
    const query = buildCompressionQuery(
      {
        command: `node ${"--trace-warnings ".repeat(100)}`,
        filePath: "src/security/auth.ts",
      },
      "investigate the active authentication module",
    );

    expect(query).toContain("src/security/auth.ts");
    expect(query.length).toBeLessThanOrEqual(2_000);
  });
});
