import { describe, expect, it } from "vitest";

import { PARITY_FIXTURES } from "../benchmarks/parity/fixtures.js";
import {
  HEADROOM_CONTENT_ROUTER_SHA256,
  HEADROOM_ORACLE_COMMIT,
  HEADROOM_ORACLE_PROFILE,
  loadParityOracle,
  validateParityOracle,
} from "../benchmarks/parity/oracle.js";

describe("Headroom parity oracle", () => {
  it("pins every annotated fixture to the reviewed Headroom target", async () => {
    const oracle = await loadParityOracle();

    expect(oracle.reference.commit).toBe(HEADROOM_ORACLE_COMMIT);
    expect(oracle.reference.profile).toBe(HEADROOM_ORACLE_PROFILE);
    expect(oracle.reference.contentRouterSha256).toBe(
      HEADROOM_CONTENT_ROUTER_SHA256,
    );
    expect(oracle.fixtures.map((fixture) => fixture.id)).toEqual(
      PARITY_FIXTURES.map((fixture) => fixture.id),
    );
    expect(() => validateParityOracle(oracle, PARITY_FIXTURES)).not.toThrow();
    expect(
      oracle.fixtures.find((fixture) => fixture.id === "mixed-stdout-stderr")
        ?.structureValid,
    ).toBe(false);
  });

  it("rejects fixture drift instead of silently comparing stale data", async () => {
    const oracle = await loadParityOracle();
    const drifted = PARITY_FIXTURES.map((fixture, index) =>
      index === 0 ? { ...fixture, content: `${fixture.content}\nchanged` } : fixture,
    );

    expect(() => validateParityOracle(oracle, drifted)).toThrow(
      /fixture hash mismatch/,
    );
  });

  it("rejects incomplete snapshots", async () => {
    const oracle = await loadParityOracle();
    const incomplete = {
      ...oracle,
      fixtures: oracle.fixtures.slice(1),
    };

    expect(() => validateParityOracle(incomplete, PARITY_FIXTURES)).toThrow(
      /fixture ids mismatch/,
    );
  });
});
