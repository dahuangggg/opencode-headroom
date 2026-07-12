import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { HeadroomNativePlugin } from "../src/plugin.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { createBunSQLiteStore } from "../src/store/sqlite-bun.js";
import {
  DEFAULT_CCR_RETRIEVE_MAX_CHARS,
  type CCRStore,
} from "../src/store/types.js";
import { estimateTokens } from "../src/token.js";
import {
  createExactCodeFixture,
  createExactDiffFixture,
  createQualityCorpus,
  QUALITY_TARGETS,
  type QualityFixture,
} from "./quality-fixtures.js";

type Adapter = "memory" | "bun-sqlite";

interface FixtureQualityResult {
  adapter: Adapter;
  target: string;
  fixture: QualityFixture;
  originalTokens: number;
  compressedTokens: number;
  boundedRetrieveTokens: number;
}

const ADAPTERS = ["memory", "bun-sqlite"] as const;
const TTL_MS = 60_000;
const QUERY_MAX_CHARS = 2_000;

function pluginInput(directory: string) {
  return {
    client: {},
    project: { id: "quality-gate" },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {},
  } as never;
}

async function withStore<T>(
  adapter: Adapter,
  run: (store: CCRStore, directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-headroom-quality-"));
  let store: CCRStore | undefined;
  try {
    store =
      adapter === "memory"
        ? new MemoryCCRStore()
        : await createBunSQLiteStore(join(directory, "quality.sqlite"));
    return await run(store, directory);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertFixtureQuality(
  engine: NativeHeadroomCompatibleEngine,
  adapter: Adapter,
  target: (typeof QUALITY_TARGETS)[number],
  fixture: QualityFixture,
): Promise<FixtureQualityResult> {
  const caseName = `${adapter}/${target.label}/${fixture.name}`;
  const sessionID = `quality-${adapter}-${target.label}-${fixture.name}`;
  assert.ok(
    Buffer.byteLength(fixture.content, "utf8") >= target.bytes,
    `${caseName} did not reach its declared payload size`,
  );

  const compressed = await engine.compress({
    tool: "Bash",
    sessionID,
    callID: `compress-${target.label}-${fixture.name}`,
    args: { query: fixture.query },
    output: fixture.content,
    ttlMs: TTL_MS,
  });

  assert.equal(compressed.changed, true, `${caseName} must be compressed`);
  assert.ok(compressed.hash, `${caseName} must receive a CCR hash`);
  for (const fact of fixture.mustKeep) {
    assert.ok(
      compressed.output.includes(fact),
      `${caseName} dropped mustKeep fact from compressed output: ${JSON.stringify(fact)}`,
    );
  }

  const full = await engine.retrieve(
    compressed.hash,
    { mode: "full" },
    sessionID,
  );
  assert.equal(full.found, true, `${caseName} full retrieve must exist`);
  assert.equal(
    full.output,
    fixture.content,
    `${caseName} explicit-full retrieve must be byte-exact`,
  );

  const partial = await engine.retrieve(
    compressed.hash,
    {
      mode: "query",
      query: fixture.query,
      contextLines: 0,
      maxMatches: Math.max(2, fixture.mustKeep.length),
      maxChars: QUERY_MAX_CHARS,
    },
    sessionID,
  );
  assert.equal(partial.found, true, `${caseName} query retrieve must exist`);
  assert.ok(
    partial.output.length <= QUERY_MAX_CHARS,
    `${caseName} query returned ${partial.output.length} chars for maxChars=${QUERY_MAX_CHARS}`,
  );
  for (const fact of fixture.mustKeep) {
    assert.ok(
      partial.output.includes(fact),
      `${caseName} query retrieve missed mustKeep fact: ${JSON.stringify(fact)}`,
    );
  }

  const bounded = await engine.retrieve(compressed.hash, undefined, sessionID);
  const boundedRetrieveTokens = estimateTokens(bounded.output);
  assert.equal(bounded.found, true, `${caseName} default retrieve must exist`);
  assert.notEqual(
    bounded.output,
    fixture.content,
    `${caseName} bare retrieve must remain bounded`,
  );
  assert.ok(
    bounded.output.length <= DEFAULT_CCR_RETRIEVE_MAX_CHARS,
    `${caseName} default retrieve exceeded ${DEFAULT_CCR_RETRIEVE_MAX_CHARS} chars`,
  );
  assert.ok(
    compressed.originalTokens - compressed.compressedTokens - boundedRetrieveTokens >=
      0,
    `${caseName} default retrieve erased estimated compression savings`,
  );

  return {
    adapter,
    target: target.label,
    fixture,
    originalTokens: compressed.originalTokens,
    compressedTokens: compressed.compressedTokens,
    boundedRetrieveTokens,
  };
}

async function assertExactCodePassthrough(
  adapter: Adapter,
  directory: string,
): Promise<number> {
  const plugin = await HeadroomNativePlugin(pluginInput(directory), {
    storage: {
      kind: adapter,
      path: join(directory, "exact-code.sqlite"),
    },
    thresholdChars: 10,
    thresholdTokens: 1,
    maxOutputChars: 300 * 1024,
  });

  let cases = 0;
  try {
    for (const target of QUALITY_TARGETS) {
      const original = createExactCodeFixture(target.bytes);
      const output: {
        title: string;
        output: string;
        metadata: Record<string, unknown>;
      } = {
        title: "Read",
        output: original,
        metadata: {},
      };

      await plugin["tool.execute.after"]!(
        {
          tool: "Read",
          sessionID: `exact-${adapter}-${target.label}`,
          callID: `exact-${target.label}`,
          args: { filePath: `src/exact-${target.label}.ts` },
        },
        output,
      );

      assert.equal(
        output.output,
        original,
        `${adapter}/${target.label}/exact-code must remain byte-exact`,
      );
      assert.equal(
        output.output.includes("[Retrieve more: hash="),
        false,
        `${adapter}/${target.label}/exact-code must not receive a CCR marker`,
      );
      cases += 1;
    }
  } finally {
    await plugin.dispose?.();
  }
  return cases;
}

async function assertExactDiffPassthrough(
  engine: NativeHeadroomCompatibleEngine,
  adapter: Adapter,
  target: (typeof QUALITY_TARGETS)[number],
): Promise<void> {
  const original = createExactDiffFixture(target.bytes);
  const result = await engine.compress({
    tool: "Bash",
    sessionID: `exact-diff-${adapter}-${target.label}`,
    callID: `exact-diff-${target.label}`,
    args: { query: "diff boundary" },
    output: original,
    ttlMs: TTL_MS,
  });
  assert.equal(
    result.changed,
    false,
    `${adapter}/${target.label}/exact-diff must be preserved`,
  );
  assert.equal(
    result.output,
    original,
    `${adapter}/${target.label}/exact-diff must remain byte-exact`,
  );
}

function savings(results: FixtureQualityResult[]): {
  originalTokens: number;
  netTokens: number;
  ratio: number;
} {
  const originalTokens = results.reduce(
    (sum, result) => sum + result.originalTokens,
    0,
  );
  const netTokens = results.reduce(
    (sum, result) =>
      sum +
      result.originalTokens -
      result.compressedTokens -
      result.boundedRetrieveTokens,
    0,
  );
  return {
    originalTokens,
    netTokens,
    ratio: netTokens / originalTokens,
  };
}

export async function runQualityGate(): Promise<void> {
  const corpora = new Map(
    QUALITY_TARGETS.map((target) => [
      target.label,
      createQualityCorpus(target.bytes),
    ]),
  );
  const results: FixtureQualityResult[] = [];
  let exactCodeCases = 0;

  for (const adapter of ADAPTERS) {
    await withStore(adapter, async (store, directory) => {
      const engine = new NativeHeadroomCompatibleEngine(store);
      for (const target of QUALITY_TARGETS) {
        const corpus = corpora.get(target.label);
        assert.ok(corpus, `missing corpus for ${target.label}`);
        for (const fixture of corpus) {
          results.push(
            await assertFixtureQuality(engine, adapter, target, fixture),
          );
        }
        await assertExactDiffPassthrough(engine, adapter, target);
      }
      exactCodeCases += await assertExactCodePassthrough(adapter, directory);
    });
  }

  const structured = results.filter((result) => result.fixture.structured);
  const structuredSavings = savings(structured);
  assert.ok(
    structuredSavings.ratio >= 0.5,
    `structured aggregate estimated net savings fell below 50% (${structuredSavings.netTokens}/${structuredSavings.originalTokens})`,
  );

  const totalSavings = savings(results);
  assert.ok(
    totalSavings.ratio >= 0.5,
    `release corpus aggregate estimated net savings fell below 50% (${totalSavings.netTokens}/${totalSavings.originalTokens})`,
  );

  const mustKeepFacts = results.reduce(
    (count, result) => count + result.fixture.mustKeep.length,
    0,
  );
  console.log(
    `quality gate passed: ${results.length} exact CCR round-trips across ` +
      `${ADAPTERS.length} adapters, ${QUALITY_TARGETS.length} payload sizes, and ` +
      `${corpora.values().next().value?.length ?? 0} fixture shapes; ` +
      `${mustKeepFacts} compressed/query mustKeep checks, ${exactCodeCases} exact-code passthroughs, ` +
      `${ADAPTERS.length * QUALITY_TARGETS.length} exact-diff passthroughs, ` +
      `${results.length} bounded non-negative default retrieves; ` +
      `${(structuredSavings.ratio * 100).toFixed(1)}% structured and ` +
      `${(totalSavings.ratio * 100).toFixed(1)}% overall estimated net savings`,
  );
}

if (import.meta.main) {
  await runQualityGate();
}
