import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HeadroomNativePlugin } from "../src/plugin.js";
import { logFixture } from "./fixtures.js";

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

describe("trusted output-file source", () => {
  it("does not read an outputPath outside the allowed roots", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-headroom-worktree-"));
    const outside = mkdtempSync(join(tmpdir(), "opencode-headroom-outside-"));
    const outputPath = join(outside, "secret-output.txt");
    writeFileSync(outputPath, `${logFixture()}\nSECRET_FROM_OUTSIDE_ROOT`, "utf8");

    try {
      const plugin = await HeadroomNativePlugin(pluginInput(worktree), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        debug: true,
        debugSink: "metadata",
      });
      const displayOutput = "...output truncated...\nOpenCode display only";
      const output = {
        title: "Bash",
        output: displayOutput,
        metadata: {
          truncated: true,
          outputPath,
        },
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "Bash",
          sessionID: "session-1",
          callID: "call-1",
          args: { command: "build" },
        },
        output,
      );

      expect(output.output).toBe(displayOutput);
      expect(output.output).not.toContain("SECRET_FROM_OUTSIDE_ROOT");
      expect(output.metadata.headroom.debug).toMatchObject({
        decision: "skipped",
        reason: "source_denied",
        source: {
          kind: "toolOutput",
          readError: "untrusted_output_path",
        },
      });
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports denied file-source fallbacks through stats with debug disabled", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-headroom-worktree-"));
    const outside = mkdtempSync(join(tmpdir(), "opencode-headroom-outside-"));
    const outputPath = join(outside, "private-output.txt");
    writeFileSync(outputPath, logFixture(), "utf8");

    try {
      const plugin = await HeadroomNativePlugin(pluginInput(worktree), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        debug: false,
      });
      const output = {
        title: "Bash",
        output: "...output truncated...\nSafe display",
        metadata: { truncated: true, outputPath },
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "Bash",
          sessionID: "session-1",
          callID: "call-1",
          args: {},
        },
        output,
      );
      const stats = await plugin.tool!.headroom_stats.execute(
        { sessionOnly: true },
        { sessionID: "session-1" } as never,
      );
      const statsText =
        typeof stats === "string" ? stats : (stats as { output: string }).output;

      expect(output.metadata.headroom).toBeUndefined();
      expect(statsText).toContain("source_denied=1");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not read a path from a tool that is not explicitly trusted", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-headroom-worktree-"));
    const outputPath = join(worktree, "secret-output.txt");
    writeFileSync(outputPath, `${logFixture()}\nSECRET_FROM_UNTRUSTED_TOOL`, "utf8");

    try {
      const plugin = await HeadroomNativePlugin(pluginInput(worktree), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        debug: true,
        outputFiles: { allowedRoots: ["."], trustedTools: ["Bash"] },
      });
      const displayOutput = "...output truncated...\nCustom tool display only";
      const output = {
        title: "Custom",
        output: displayOutput,
        metadata: { truncated: true, outputPath },
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "Custom",
          sessionID: "session-1",
          callID: "call-1",
          args: {},
        },
        output,
      );

      expect(output.output).not.toContain("SECRET_FROM_UNTRUSTED_TOOL");
      expect(output.metadata.headroom.debug.source).toMatchObject({
        kind: "toolOutput",
        readError: "untrusted_output_path",
      });
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that escapes an allowed root", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-headroom-worktree-"));
    const outside = mkdtempSync(join(tmpdir(), "opencode-headroom-outside-"));
    const outsidePath = join(outside, "secret-output.txt");
    const outputPath = join(worktree, "escaped-output.txt");
    writeFileSync(outsidePath, `${logFixture()}\nSECRET_BEHIND_SYMLINK`, "utf8");
    symlinkSync(outsidePath, outputPath);

    try {
      const plugin = await HeadroomNativePlugin(pluginInput(worktree), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        debug: true,
      });
      const displayOutput = "...output truncated...\nSafe display";
      const output = {
        title: "Bash",
        output: displayOutput,
        metadata: { truncated: true, outputPath },
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "Bash",
          sessionID: "session-1",
          callID: "call-1",
          args: {},
        },
        output,
      );

      expect(output.output).not.toContain("SECRET_BEHIND_SYMLINK");
      expect(output.metadata.headroom.debug.source.readError).toBe(
        "untrusted_output_path",
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects an oversized file before exposing its content", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-headroom-worktree-"));
    const outputPath = join(worktree, "oversized-output.txt");
    writeFileSync(outputPath, "SECRET_OVERSIZED\n".repeat(100), "utf8");

    try {
      const plugin = await HeadroomNativePlugin(pluginInput(worktree), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        maxOutputChars: 100,
        debug: true,
      });
      const displayOutput = "...output truncated...\nSafe display";
      const output = {
        title: "Bash",
        output: displayOutput,
        metadata: { truncated: true, outputPath },
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "Bash",
          sessionID: "session-1",
          callID: "call-1",
          args: {},
        },
        output,
      );

      expect(output.output).toBe(displayOutput);
      expect(output.output).not.toContain("SECRET_OVERSIZED");
      expect(output.metadata.headroom.debug).toMatchObject({
        decision: "skipped",
        reason: "too_large",
        source: { readError: "output_path_too_large" },
      });
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("rejects a non-regular output path", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "opencode-headroom-worktree-"));
    const outputPath = join(worktree, "output-directory");
    mkdirSync(outputPath);

    try {
      const plugin = await HeadroomNativePlugin(pluginInput(worktree), {
        storage: { kind: "memory" },
        thresholdChars: 10,
        thresholdTokens: 1,
        debug: true,
      });
      const output = {
        title: "Bash",
        output: "...output truncated...\nSafe display",
        metadata: { truncated: true, outputPath },
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "Bash",
          sessionID: "session-1",
          callID: "call-1",
          args: {},
        },
        output,
      );

      expect(output.metadata.headroom.debug.source.readError).toBe(
        "output_path_not_regular",
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
