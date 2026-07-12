import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/config.js";
import { HeadroomNativePlugin } from "../src/plugin.js";
import { logFixture, searchFixture } from "./fixtures.js";

function pluginInput(directory: string) {
  return {
    client: {},
    project: { id: "project-1" },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {},
  } as never;
}

describe("user tool policy", () => {
  it("preserves a matched tool before reading its outputPath", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-headroom-policy-"));
    const outputPath = join(directory, "full-output.txt");
    writeFileSync(outputPath, logFixture(), "utf8");

    try {
      const plugin = await HeadroomNativePlugin(pluginInput(directory), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        debug: true,
        debugSink: "metadata",
        toolPolicy: {
          rules: [
            {
              id: "keep-read-exact",
              tools: ["Read"],
              action: "preserve",
            },
          ],
        },
      });
      const displayOutput = "...output truncated...\nRead output display";
      const output = {
        title: "Read",
        output: displayOutput,
        metadata: {
          truncated: true,
          outputPath,
        },
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "Read",
          sessionID: "session-1",
          callID: "call-1",
          args: { filePath: "src/example.ts" },
        },
        output,
      );

      expect(output.output).toBe(displayOutput);
      expect(output.metadata.headroom.debug).toMatchObject({
        decision: "skipped",
        reason: "user_preserve",
        source: {
          kind: "toolOutput",
          displayChars: displayOutput.length,
          originalChars: displayOutput.length,
        },
        policy: {
          ruleId: "keep-read-exact",
          source: "user",
          action: "preserve",
        },
      });
      expect(output.metadata.headroom.debug.source.path).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("matches tool globs case-insensitively", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      debug: true,
      debugSink: "metadata",
      toolPolicy: {
        rules: [
          {
            id: "keep-mcp-logs",
            tools: ["MCP_*_LOGS"],
            action: "preserve",
          },
        ],
      },
    });
    const original = logFixture();
    const output = { title: "logs", output: original, metadata: {} };

    await plugin["tool.execute.after"]!(
      {
        tool: "mcp_team_logs",
        sessionID: "session-1",
        callID: "call-2",
        args: {},
      },
      output,
    );

    expect(output.output).toBe(original);
    expect(output.metadata.headroom.debug.policy).toMatchObject({
      ruleId: "keep-mcp-logs",
      source: "user",
      action: "preserve",
    });
  });

  it("rejects duplicate rule ids during plugin configuration", () => {
    expect(() =>
      normalizeConfig({
        toolPolicy: {
          rules: [
            { id: "duplicate", tools: ["Read"], action: "preserve" },
            { id: "duplicate", tools: ["Bash"], action: "compress" },
          ],
        },
      }),
    ).toThrow(/duplicate tool policy rule id/i);
  });

  it("preserves exact-content tools by default", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      debug: true,
      debugSink: "metadata",
    });
    const original = Array.from(
      { length: 80 },
      (_, index) =>
        `export function value${index}() {\n  return ${index};\n}`,
    ).join("\n\n");
    const output = { title: "Read", output: original, metadata: {} };

    await plugin["tool.execute.after"]!(
      {
        tool: "Read",
        sessionID: "session-1",
        callID: "call-3",
        args: { filePath: "src/example.ts" },
      },
      output,
    );

    expect(output.output).toBe(original);
    expect(output.metadata.headroom.debug).toMatchObject({
      decision: "skipped",
      reason: "builtin_preserve",
      policy: {
        ruleId: "builtin-exact-content",
        source: "builtin",
        action: "preserve",
      },
    });
  });

  it("reports a preserve action selected by toolPolicy.default", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
      storage: { kind: "memory" },
      debug: true,
      toolPolicy: { default: { action: "preserve" } },
    });
    const output = { title: "Custom", output: logFixture(), metadata: {} };

    await plugin["tool.execute.after"]!(
      {
        tool: "Custom",
        sessionID: "session-default-preserve",
        callID: "call-default-preserve",
        args: {},
      },
      output,
    );

    expect(output.metadata.headroom.debug).toMatchObject({
      decision: "skipped",
      reason: "default_preserve",
      policy: { ruleId: "default", source: "default", action: "preserve" },
    });
  });

  it("applies a per-tool minimum before compression", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      debug: true,
      debugSink: "metadata",
      toolPolicy: {
        rules: [
          {
            id: "large-bash-only",
            tools: ["Bash"],
            action: "compress",
            minimum: {
              chars: 100_000,
              tokens: 25_000,
            },
          },
        ],
      },
    });
    const original = logFixture();
    const output = { title: "Bash", output: original, metadata: {} };

    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "session-1",
        callID: "call-4",
        args: { command: "bun test" },
      },
      output,
    );

    expect(output.output).toBe(original);
    expect(output.metadata.headroom.debug).toMatchObject({
      decision: "skipped",
      reason: "below_threshold",
      threshold: {
        chars: 100_000,
        tokens: 25_000,
      },
      policy: {
        ruleId: "large-bash-only",
        source: "user",
      },
    });
  });

  it("rejects non-positive per-tool minimums", () => {
    expect(() =>
      normalizeConfig({
        toolPolicy: {
          rules: [
            {
              id: "invalid-minimum",
              tools: ["Bash"],
              action: "compress",
              minimum: { tokens: 0 },
            },
          ],
        },
      }),
    ).toThrow(/minimum tokens must be a positive finite number/i);
  });

  it("rejects invalid enums, empty selectors, and meaningless preserve options", () => {
    expect(() =>
      normalizeConfig({
        toolPolicy: {
          default: { action: "rewrite" as never },
        },
      }),
    ).toThrow(/toolPolicy\.default\.action/i);

    expect(() =>
      normalizeConfig({
        toolPolicy: {
          rules: [
            { id: "", tools: ["Bash"], action: "compress" },
          ],
        },
      }),
    ).toThrow(/rule id/i);

    expect(() =>
      normalizeConfig({
        toolPolicy: {
          rules: [
            { id: "no-tools", tools: [], action: "compress" },
          ],
        },
      }),
    ).toThrow(/at least one tool pattern/i);

    expect(() =>
      normalizeConfig({
        toolPolicy: {
          rules: [
            {
              id: "invalid-preserve",
              tools: ["Read"],
              action: "preserve",
              ccr: { ttlHours: 1 },
            },
          ],
        },
      }),
    ).toThrow(/preserve.*ccr/i);
  });

  it("rejects invalid CCR and retrieve overrides", () => {
    expect(() =>
      normalizeConfig({
        toolPolicy: {
          rules: [
            {
              id: "invalid-ttl",
              tools: ["Bash"],
              action: "compress",
              ccr: { ttlHours: Number.NaN },
            },
          ],
        },
      }),
    ).toThrow(/ttlHours must be a positive finite number/i);

    expect(() =>
      normalizeConfig({
        toolPolicy: {
          rules: [
            {
              id: "invalid-retrieve",
              tools: ["Bash"],
              action: "compress",
              retrieve: { defaultMode: "query" as never, maxChars: 0 },
            },
          ],
        },
      }),
    ).toThrow(/retrieve\.defaultMode/i);
  });

  it("lets an explicit user rule override legacy skipTools", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
      storage: { kind: "memory" },
      thresholdChars: 100_000,
      thresholdTokens: 25_000,
      skipTools: ["Bash"],
      debug: true,
      toolPolicy: {
        rules: [
          {
            id: "explicit-bash-compress",
            tools: ["Bash"],
            action: "compress",
            minimum: "always",
          },
        ],
      },
    });
    const output = { title: "Bash", output: searchFixture(), metadata: {} };

    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "session-1",
        callID: "call-5",
        args: { command: "rg auth" },
      },
      output,
    );

    expect(output.output).toContain("[Retrieve more: hash=");
    expect(output.metadata.headroom.debug.policy).toMatchObject({
      ruleId: "explicit-bash-compress",
      source: "user",
      action: "compress",
    });
  });

  it("does not let user policy override recursive headroom tool safety", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      debug: true,
      toolPolicy: {
        rules: [
          {
            id: "unsafe-recursive-rule",
            tools: ["headroom_*"],
            action: "compress",
            minimum: "always",
          },
        ],
      },
    });
    const original = searchFixture();
    const output = {
      title: "headroom_retrieve",
      output: original,
      metadata: {},
    };

    await plugin["tool.execute.after"]!(
      {
        tool: "headroom_retrieve",
        sessionID: "session-recursive-safety",
        callID: "call-recursive-safety",
        args: {},
      },
      output,
    );

    expect(output.output).toBe(original);
    expect(output.metadata.headroom.debug.policy).toMatchObject({
      ruleId: "safety-headroom-tools",
      source: "builtin",
      action: "preserve",
    });
  });

  it("uses declaration order and lets a user compress rule override exact-content defaults", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
      storage: { kind: "memory" },
      thresholdChars: 100_000,
      thresholdTokens: 25_000,
      debug: true,
      toolPolicy: {
        rules: [
          {
            id: "compress-read-search",
            tools: ["Read"],
            action: "compress",
            minimum: "always",
          },
          {
            id: "later-preserve",
            tools: ["R*"],
            action: "preserve",
          },
        ],
      },
    });
    const output = { title: "Read", output: searchFixture(), metadata: {} };

    await plugin["tool.execute.after"]!(
      {
        tool: "Read",
        sessionID: "session-1",
        callID: "call-6",
        args: { filePath: "search-results.txt" },
      },
      output,
    );

    expect(output.output).toContain("[Retrieve more: hash=");
    expect(output.metadata.headroom.debug.policy.ruleId).toBe(
      "compress-read-search",
    );
  });

  it("maps public strength choices to different private compression budgets", async () => {
    async function outputFor(
      strength: "conservative" | "aggressive",
    ): Promise<string> {
      const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        toolPolicy: {
          rules: [
            {
              id: `${strength}-bash`,
              tools: ["Bash"],
              action: "compress",
              strength,
            },
          ],
        },
      });
      const output = { title: "Bash", output: searchFixture(), metadata: {} };
      await plugin["tool.execute.after"]!(
        {
          tool: "Bash",
          sessionID: `session-${strength}`,
          callID: "call-strength",
          args: { command: "rg auth" },
        },
        output,
      );
      return output.output;
    }

    const conservative = await outputFor("conservative");
    const aggressive = await outputFor("aggressive");

    expect(conservative).toContain("[Retrieve more: hash=");
    expect(aggressive).toContain("[Retrieve more: hash=");
    expect(aggressive.length).toBeLessThan(conservative.length);
  });

  it("stores the selected bounded retrieve default with the CCR entry", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      toolPolicy: {
        rules: [
          {
            id: "bash-tail-retrieve",
            tools: ["Bash"],
            action: "compress",
            retrieve: { defaultMode: "tail", maxChars: 300 },
          },
        ],
      },
    });
    const output = { title: "Bash", output: searchFixture(), metadata: {} };
    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "session-retrieve-default",
        callID: "call-retrieve-default",
        args: { command: "rg auth" },
      },
      output,
    );

    const retrieved = await plugin.tool!.headroom_retrieve.execute(
      { hash: output.metadata.headroom.hash },
      { sessionID: "session-retrieve-default" } as never,
    );
    const content =
      typeof retrieved === "string" ? retrieved : retrieved.output;

    expect(content).toContain("mode: tail");
    expect(content.length).toBeLessThanOrEqual(300);
  });

  it("allows an explicit full retrieve default for compatibility", async () => {
    const original = searchFixture();
    const plugin = await HeadroomNativePlugin(pluginInput(process.cwd()), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
      toolPolicy: {
        rules: [
          {
            id: "legacy-full-retrieve",
            tools: ["Bash"],
            action: "compress",
            retrieve: { defaultMode: "full" },
          },
        ],
      },
    });
    const output = { title: "Bash", output: original, metadata: {} };
    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "session-full-default",
        callID: "call-full-default",
        args: { command: "rg auth" },
      },
      output,
    );

    const retrieved = await plugin.tool!.headroom_retrieve.execute(
      { hash: output.metadata.headroom.hash },
      { sessionID: "session-full-default" } as never,
    );
    const content =
      typeof retrieved === "string" ? retrieved : retrieved.output;

    expect(content).toBe(original);
  });
});
