import { describe, expect, it } from "vitest";

describe("package entrypoint", () => {
  it("exposes only OpenCode plugin entrypoints at runtime", async () => {
    const mod = await import("../src/index.js");

    expect(Object.keys(mod).sort()).toEqual([
      "HeadroomNativePlugin",
      "default",
      "server",
    ]);
    expect(mod.server).toBe(mod.HeadroomNativePlugin);
    expect(mod.default).toBe(mod.HeadroomNativePlugin);
  });
});
