import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ParityFixture,
  ParityOracleSnapshot,
} from "./types.js";

export const HEADROOM_ORACLE_COMMIT =
  "52a024d28cff7808659240b3f4c5ceb4fa11e0e8";
export const HEADROOM_ORACLE_PROFILE = "coding";
export const HEADROOM_CONTENT_ROUTER_SHA256 =
  "608722c25ee2326e1259597dd6d78463a0c79a7470232a92263afa9c1b9deb08";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function fixtureSha256(fixture: ParityFixture): string {
  return sha256(
    JSON.stringify({
      id: fixture.id,
      kind: fixture.kind,
      tool: fixture.tool,
      query: fixture.query,
      content: fixture.content,
      protectedFacts: fixture.protectedFacts,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(value: unknown): ParityOracleSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("unsupported Headroom oracle schema");
  }
  if (!isRecord(value.reference) || !Array.isArray(value.fixtures)) {
    throw new Error("incomplete Headroom oracle snapshot");
  }
  return value as unknown as ParityOracleSnapshot;
}

export async function loadParityOracle(
  url = new URL("./oracle.json", import.meta.url),
): Promise<ParityOracleSnapshot> {
  const raw = await readFile(url, "utf8");
  return parseSnapshot(JSON.parse(raw) as unknown);
}

export function validateParityOracle(
  oracle: ParityOracleSnapshot,
  fixtures: readonly ParityFixture[],
): void {
  if (
    oracle.reference.package !== "headroom-ai" ||
    oracle.reference.version !== "0.31.0" ||
    oracle.reference.commit !== HEADROOM_ORACLE_COMMIT ||
    oracle.reference.profile !== HEADROOM_ORACLE_PROFILE ||
    oracle.reference.contentRouterSha256 !== HEADROOM_CONTENT_ROUTER_SHA256
  ) {
    throw new Error("Headroom oracle reference mismatch");
  }

  const expectedIds = fixtures.map((fixture) => fixture.id);
  const actualIds = oracle.fixtures.map((fixture) => fixture.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(
      `Headroom oracle fixture ids mismatch: expected ${expectedIds.join(", ")}; got ${actualIds.join(", ")}`,
    );
  }

  fixtures.forEach((fixture, index) => {
    const baseline = oracle.fixtures[index];
    if (!baseline) {
      throw new Error(`Headroom oracle missing fixture ${fixture.id}`);
    }
    if (baseline.fixtureSha256 !== fixtureSha256(fixture)) {
      throw new Error(`Headroom oracle fixture hash mismatch: ${fixture.id}`);
    }
    if (
      JSON.stringify(baseline.protectedFacts) !==
      JSON.stringify(fixture.protectedFacts)
    ) {
      throw new Error(`Headroom oracle protected facts mismatch: ${fixture.id}`);
    }
    if (
      !baseline.strategy ||
      !Number.isInteger(baseline.originalTokens) ||
      baseline.originalTokens <= 0 ||
      !Number.isInteger(baseline.outputTokens) ||
      baseline.outputTokens <= 0 ||
      !/^[a-f0-9]{64}$/.test(baseline.outputSha256) ||
      !Array.isArray(baseline.retainedFacts)
    ) {
      throw new Error(`Headroom oracle fixture result is incomplete: ${fixture.id}`);
    }
  });
}
