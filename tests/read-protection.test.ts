import { describe, expect, it } from "vitest";

import { HeadroomNativePlugin } from "../src/plugin.js";
import {
  isRawFileReadCommand,
  shouldPreserveRawFileRead,
} from "../src/read-protection.js";

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

function largeCodeFixture(): string {
  return Array.from(
    { length: 80 },
    (_, index) =>
      [
        `export function transform${index}(input: string): string {`,
        `  const normalized = input.trim() + ${JSON.stringify(String(index))};`,
        "  return normalized.toUpperCase();",
        "}",
      ].join("\n"),
  ).join("\n\n");
}

describe("shell raw-file read protection", () => {
  it("recognizes direct and wrapped reads without treating writes or lockfiles as reads", () => {
    expect(isRawFileReadCommand("cat src/index.ts")).toBe(true);
    expect(isRawFileReadCommand("cd /repo && sudo timeout 30 cat src/index.ts")).toBe(
      true,
    );
    expect(isRawFileReadCommand("bash -lc 'sed -n 1,80p src/index.ts'")).toBe(true);
    expect(isRawFileReadCommand("cat > src/index.ts <<'EOF'")).toBe(false);
    expect(isRawFileReadCommand("sed 's/a/b/' src/index.ts")).toBe(false);
    expect(isRawFileReadCommand("cat package-lock.json")).toBe(false);
    expect(isRawFileReadCommand("rg transform src")).toBe(false);
  });

  it("protects code and plain text while releasing confidently structured data", () => {
    expect(
      shouldPreserveRawFileRead(
        { command: "cat src/index.ts" },
        largeCodeFixture(),
      ),
    ).toBe(true);
    expect(
      shouldPreserveRawFileRead(
        { command: "cat README.custom" },
        "implementation notes\n".repeat(80),
      ),
    ).toBe(true);
    expect(
      shouldPreserveRawFileRead(
        { command: "cat data.json" },
        JSON.stringify(Array.from({ length: 40 }, (_, id) => ({ id }))),
      ),
    ).toBe(false);
  });

  it("keeps a Bash code read byte-exact before the normal compressor runs", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      debug: true,
      debugSink: "metadata",
    });
    const original = largeCodeFixture();
    const output = { title: "Bash", output: original, metadata: {} as any };

    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "read-session",
        callID: "read-call",
        args: { command: "cd /repo && cat src/index.ts" },
      },
      output,
    );

    expect(output.output).toBe(original);
    expect(output.metadata.headroom.debug).toMatchObject({
      decision: "skipped",
      reason: "read_protected",
      policy: {
        ruleId: "builtin-shell-read",
        source: "builtin",
        action: "preserve",
      },
    });
  });
});
