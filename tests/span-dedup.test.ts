import { describe, expect, it } from "vitest";

import {
  deduplicateSpans,
  isPrefixMonotonic,
  type SpanDedupBlock,
} from "../src/session/span-dedup.js";

function sharedLines(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `shared record ${index}: stable payload value ${index}`,
  );
}

describe("cross-turn span deduplication", () => {
  it("folds a large repeated span even when the whole outputs are dissimilar", () => {
    const shared = sharedLines(60);
    const blocks: SpanDedupBlock[] = [
      {
        turn: 2,
        text: [...shared, ...sharedLines(20).map((line) => `old ${line}`)].join("\n"),
      },
      {
        turn: 5,
        text: [...shared, ...sharedLines(20).map((line) => `new ${line}`)].join("\n"),
      },
    ];

    const result = deduplicateSpans(blocks);

    expect(result.blocks[0]?.text).toBe(blocks[0]?.text);
    expect(result.blocks[1]?.text).toContain("[↑60L same as msg 2");
    expect(result.blocks[1]?.text).toContain("new shared record 19");
    expect(result.stats).toMatchObject({ spansFolded: 1, linesRemoved: 60 });
  });

  it("folds line-numbered rereads only when every line has one constant offset", () => {
    const original = Array.from(
      { length: 8 },
      (_, index) => `${100 + index}:const value${index} = ${index};`,
    ).join("\n");
    const shifted = Array.from(
      { length: 8 },
      (_, index) => `${105 + index}:const value${index} = ${index};`,
    ).join("\n");

    const result = deduplicateSpans([
      { turn: 1, text: original },
      { turn: 3, text: shifted },
    ]);

    expect(result.blocks[1]?.text).toContain("same as msg 1 +5L");
  });

  it("keeps protected blocks unchanged while allowing them to be reference targets", () => {
    const text = sharedLines(12).join("\n");
    const result = deduplicateSpans([
      { turn: 1, text, protected: true },
      { turn: 2, text },
    ]);

    expect(result.blocks[0]?.text).toBe(text);
    expect(result.blocks[1]?.text).toContain("same as msg 1");
  });

  it("leaves short or trivial repeats alone and stays prefix-monotonic", () => {
    const short = ["try:", "pass", "else:"].join("\n");
    const substantial = sharedLines(8).join("\n");
    const blocks = [
      { turn: 1, text: short },
      { turn: 2, text: short },
      { turn: 3, text: substantial },
      { turn: 4, text: substantial },
      { turn: 5, text: `${substantial}\nunique tail` },
    ];

    const result = deduplicateSpans(blocks);

    expect(result.blocks[1]?.text).toBe(short);
    expect(isPrefixMonotonic(blocks)).toBe(true);
  });
});
