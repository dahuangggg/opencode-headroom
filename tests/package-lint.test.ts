import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validatePackageManifest } from "../scripts/package-lint.mjs";

const manifest = JSON.parse(
  readFileSync(resolve("package.json"), "utf8"),
) as Record<string, unknown>;

describe("package manifest lint", () => {
  it("accepts the release manifest", () => {
    expect(() => validatePackageManifest(manifest)).not.toThrow();
  });

  it("rejects self-dependencies and export targets outside dist", () => {
    expect(() =>
      validatePackageManifest({
        ...manifest,
        dependencies: { [manifest.name as string]: "^0.2.0" },
      }),
    ).toThrow(/depend on itself/i);

    expect(() =>
      validatePackageManifest({
        ...manifest,
        exports: {
          ".": { default: "./src/index.ts", types: "./dist/index.d.ts" },
          "./plugin": {
            default: "./dist/plugin.js",
            types: "./dist/plugin.d.ts",
          },
        },
      }),
    ).toThrow(/export target.*dist/i);
  });
});
