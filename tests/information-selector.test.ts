import { describe, expect, it } from "vitest";

import { rankInformationItems } from "../src/engine/information-selector.js";

describe("information-aware item ranking", () => {
  it("ranks a rare semantic row ahead of routine rows", () => {
    const items = Array.from(
      { length: 20 },
      (_, index) => `tenant-${index} status ok routine cache entry`,
    );
    items[13] = "tenant-critical database shard quarantined security anomaly";

    expect(rankInformationItems(items, new Set([0, 19]))[0]).toBe(13);
  });

  it("distributes equal-information samples across the full range", () => {
    const ranked = rankInformationItems(
      Array.from({ length: 17 }, () => "same routine status"),
      new Set([0, 16]),
    );
    const firstFour = ranked.slice(0, 4);

    expect(firstFour[0]).toBeGreaterThanOrEqual(6);
    expect(firstFour[0]).toBeLessThanOrEqual(10);
    expect(firstFour.some((index) => index <= 4)).toBe(true);
    expect(firstFour.some((index) => index >= 12)).toBe(true);
  });

  it("normalizes changing numeric identifiers when measuring rarity", () => {
    const items = Array.from(
      { length: 24 },
      (_, index) => `worker-${index} processed request-${index * 101} successfully`,
    );
    items[17] = "worker-17 rejected credential because signature expired";

    expect(rankInformationItems(items, new Set([0, 23]))[0]).toBe(17);
  });

  it("is deterministic", () => {
    const items = Array.from(
      { length: 32 },
      (_, index) => `shard-${index} status ${index % 3}`,
    );
    const required = new Set([0, 31]);

    expect(rankInformationItems(items, required)).toEqual(
      rankInformationItems(items, required),
    );
  });
});
