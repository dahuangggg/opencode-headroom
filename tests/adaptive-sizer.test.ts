import { describe, expect, it } from "vitest";

import {
  computeOptimalK,
  computeUniqueBigramCurve,
  findKnee,
} from "../src/engine/adaptive-sizer.js";

describe("adaptive information sizing", () => {
  it("keeps small collections intact", () => {
    const items = Array.from({ length: 8 }, (_, index) => `item ${index}`);

    expect(
      computeOptimalK(items, { bias: 0.7, minK: 1, maxK: 8 }),
    ).toMatchObject({ k: 8, reason: "small" });
  });

  it("collapses highly repetitive collections to the configured floor", () => {
    const items = Array.from({ length: 20 }, () => "same repeated result");

    expect(
      computeOptimalK(items, { bias: 1, minK: 3, maxK: 20 }),
    ).toMatchObject({ k: 3, uniqueGroups: 1, reason: "redundant" });
  });

  it("keeps substantially more high-diversity content", () => {
    const items = Array.from(
      { length: 20 },
      (_, index) =>
        `module-${index} reports distinct symbol-${index * 17} and value-${index * 31}`,
    );

    const decision = computeOptimalK(items, {
      bias: 1,
      minK: 3,
      maxK: 20,
    });

    expect(decision.k).toBeGreaterThanOrEqual(14);
    expect(decision.diversity).toBeGreaterThan(0.7);
  });

  it("applies conservative, balanced, and aggressive bias monotonically", () => {
    const items = Array.from(
      { length: 30 },
      (_, index) => `result ${index}: symbol-${index} changed in package-${index % 7}`,
    );
    const size = (bias: number) =>
      computeOptimalK(items, { bias, minK: 3, maxK: 30 }).k;

    expect(size(1.5)).toBeGreaterThanOrEqual(size(1));
    expect(size(1)).toBeGreaterThanOrEqual(size(0.7));
  });

  it("builds an information curve for spaceless CJK text", () => {
    expect(
      computeUniqueBigramCurve(["数据库连接失败", "数据库连接成功"]),
    ).toEqual([6, 8]);
  });

  it("finds a saturation knee but rejects a linear curve", () => {
    expect(findKnee([1, 5, 8, 9, 10, 10, 10, 10, 10])).toBe(3);
    expect(findKnee([1, 2, 3, 4, 5])).toBeUndefined();
  });

  it("handles empty budgets and clamps invalid bounds", () => {
    expect(
      computeOptimalK(["a", "b"], { bias: 1, minK: 5, maxK: 0 }),
    ).toMatchObject({ k: 0 });
    expect(
      computeOptimalK(["a", "b", "c"], {
        bias: 1,
        minK: 5,
        maxK: 2,
      }),
    ).toMatchObject({ k: 2 });
  });

  it("is deterministic", () => {
    const items = Array.from(
      { length: 24 },
      (_, index) => `result ${index % 6} from shard ${index % 4}`,
    );
    const options = { bias: 1, minK: 3, maxK: 20 };

    expect(computeOptimalK(items, options)).toEqual(
      computeOptimalK(items, options),
    );
  });
});
