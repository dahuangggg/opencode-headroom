import { describe, expect, it } from "vitest";

import { HeadroomNativePlugin } from "../src/plugin.js";
import { deduplicateMessageToolOutputs } from "../src/session/message-dedup.js";

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

function sourceLines(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `export const ${prefix}${index}: number = ${index}; // stable source line ${index}`,
  );
}

function completedTool(output: string) {
  return {
    type: "tool",
    state: {
      status: "completed",
      output,
      title: "Bash",
      input: {},
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

describe("Headroom coding-profile multi-turn effects", () => {
  it("keeps each source read exact, then folds only its repeated in-context span", async () => {
    const plugin = await HeadroomNativePlugin(pluginInput(), {
      storage: { kind: "memory" },
      thresholdChars: 10,
      thresholdTokens: 1,
    });
    const shared = sourceLines("shared", 60);
    const firstRead = [...shared, ...sourceLines("old", 20)].join("\n");
    const secondRead = [...shared, ...sourceLines("new", 20)].join("\n");
    const firstOutput = { title: "Bash", output: firstRead, metadata: {} };
    const secondOutput = { title: "Bash", output: secondRead, metadata: {} };

    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "coding-session",
        callID: "read-1",
        args: { command: "cat src/example.ts" },
      },
      firstOutput,
    );
    await plugin["tool.execute.after"]!(
      {
        tool: "Bash",
        sessionID: "coding-session",
        callID: "read-2",
        args: { command: "sed -n 1,120p src/example.ts" },
      },
      secondOutput,
    );

    expect(firstOutput.output).toBe(firstRead);
    expect(secondOutput.output).toBe(secondRead);

    const messages = [
      { info: {}, parts: [completedTool(firstOutput.output)] },
      { info: {}, parts: [completedTool(secondOutput.output)] },
    ];
    await plugin["experimental.chat.messages.transform"]!(
      {},
      { messages } as never,
    );

    expect(messages[0]?.parts[0]).toMatchObject({ state: { output: firstRead } });
    expect(messages[1]?.parts[0]).toMatchObject({
      state: {
        output: expect.stringMatching(/\[↑60L same as msg 1[\s\S]*new19/),
      },
    });
  });

  it("produces the same rewritten prefix when a later turn is appended", () => {
    const shared = sourceLines("shared", 12).join("\n");
    const twoTurns = [
      { parts: [completedTool(shared)] },
      { parts: [completedTool(`${shared}\nsecond tail`)] },
    ];
    deduplicateMessageToolOutputs(twoTurns);
    const rewrittenSecond = twoTurns[1]?.parts[0]?.state.output;

    const threeTurns = [
      { parts: [completedTool(shared)] },
      { parts: [completedTool(`${shared}\nsecond tail`)] },
      { parts: [completedTool(`${shared}\nthird tail`)] },
    ];
    deduplicateMessageToolOutputs(threeTurns);

    expect(threeTurns[1]?.parts[0]?.state.output).toBe(rewrittenSecond);
    expect(threeTurns[2]?.parts[0]?.state.output).toContain("same as msg 1");
  });
});
