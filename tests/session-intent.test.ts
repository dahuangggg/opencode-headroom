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
});
