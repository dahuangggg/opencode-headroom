import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { detectContentType } from "../src/engine/router.js";
import { HeadroomNativePlugin } from "../src/plugin.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { createBunSQLiteStore } from "../src/store/sqlite-bun.js";
import type { CCRPutInput, CCRStore } from "../src/store/types.js";
import { createTokenCounter, estimateTokens } from "../src/token.js";

type StoreBackend = "memory" | "bun-sqlite";
type ReportBackend = StoreBackend | "router" | "tokenizer";

export interface PayloadCase {
  label: string;
  content: string;
  bytes: number;
}

interface Distribution {
  samples: number;
  p50: number;
  p95: number;
  max: number;
}

type Operation =
  | "token.counter(cold)"
  | "token.counter(hot)"
  | "router.detect"
  | "store.put"
  | "store.get"
  | "engine.compress"
  | "engine.retrieve(query)"
  | "plugin.tool.execute.after"
  | "plugin.messages.transform"
  | "store.put(concurrent-workers=4)"
  | "store.cold-start";

export interface PerformanceResultRow {
  backend: ReportBackend;
  payload: PayloadCase;
  operation: Operation;
  distribution: Distribution;
}

const BASE_SEED = 0x5eed_2026;
const WARMUP_RUNS = 3;
const SAMPLE_RUNS = 25;
const TTL_MS = 60 * 60 * 1000;
const QUERY = "benchmark needle validation failed";
const SQLITE_CONNECTIONS = 4;
const P0_HOOK_MAX_P95_MS = 50;
const P0_MESSAGE_TRANSFORM_MAX_P95_MS = 50;
const TARGETS = [
  { label: "10KiB", bytes: 10 * 1024 },
  { label: "100KiB", bytes: 100 * 1024 },
  { label: "250KiB", bytes: 250 * 1024 },
] as const;

interface WorkerResponse {
  id: number;
  ok: boolean;
  error?: string;
}

class SQLiteWorkerClient {
  private readonly worker = new Worker(
    new URL("./sqlite-concurrency-worker.ts", import.meta.url),
  );
  private nextID = 1;
  private failure: Error | undefined;
  private readonly pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  constructor() {
    this.worker.on("message", (response: WorkerResponse) => {
      const request = this.pending.get(response.id);
      if (!request) {
        return;
      }
      this.pending.delete(response.id);
      if (response.ok) {
        request.resolve();
      } else {
        request.reject(new Error(response.error ?? "SQLite worker failed"));
      }
    });
    this.worker.on("error", (error) => {
      this.fail(error);
    });
    this.worker.on("exit", (code) => {
      this.fail(new Error(`SQLite worker exited with code ${code}`));
    });
  }

  call(request: Record<string, unknown>): Promise<void> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id });
    });
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function makePayload(label: string, targetBytes: number): PayloadCase {
  const random = mulberry32(BASE_SEED ^ targetBytes);
  const lines: string[] = [];
  let bytes = 0;
  for (let index = 0; bytes < targetBytes; index += 1) {
    const file = `src/module_${String(Math.floor(random() * 8)).padStart(2, "0")}/worker_${String(Math.floor(random() * 12)).padStart(2, "0")}.ts`;
    const lineNumber = 100 + index * 3;
    const request = Math.floor(random() * 1_000_000_000)
      .toString(16)
      .padStart(8, "0");
    const message =
      index % 97 === 0
        ? `ERROR benchmark needle validation failed request_id=req_${request}`
        : `INFO benchmark event status=ok request_id=req_${request} batch=${index}`;
    const line = `${file}:${lineNumber}:${message}`;
    bytes += Buffer.byteLength(line) + (lines.length === 0 ? 0 : 1);
    lines.push(line);
  }
  const content = lines.join("\n");
  return { label, content, bytes: Buffer.byteLength(content) };
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

async function measure(
  operation: (iteration: number) => Promise<void>,
): Promise<Distribution> {
  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    await operation(-WARMUP_RUNS + index);
  }

  const durations: number[] = [];
  for (let index = 0; index < SAMPLE_RUNS; index += 1) {
    const startedAt = performance.now();
    await operation(index);
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  return {
    samples: durations.length,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    max: durations.at(-1) ?? 0,
  };
}

async function withStore<T>(
  backend: StoreBackend,
  run: (store: CCRStore) => Promise<T>,
): Promise<T> {
  let directory: string | undefined;
  let store: CCRStore | undefined;
  try {
    if (backend === "memory") {
      store = new MemoryCCRStore();
    } else {
      directory = await mkdtemp(join(tmpdir(), "opencode-headroom-perf-"));
      store = await createBunSQLiteStore(join(directory, "ccr.sqlite"));
    }
    return await run(store);
  } finally {
    await store?.close();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function directPutInput(
  payload: PayloadCase,
  sessionID: string,
  iteration: number,
): CCRPutInput {
  const originalContent = `${payload.content}\nperf/direct-put:${iteration}:INFO direct Store sample`;
  return {
    sessionID,
    callID: `put-${iteration}`,
    tool: "Bash",
    strategy: "search",
    originalContent,
    compressedContent: `[performance Store fixture ${iteration}]`,
    originalTokens: estimateTokens(originalContent),
    compressedTokens: 8,
    ttlMs: TTL_MS,
  };
}

async function benchmarkRouter(
  payload: PayloadCase,
): Promise<PerformanceResultRow> {
  const distribution = await measure(async () => {
    const detection = detectContentType(payload.content);
    if (detection.kind !== "search") {
      throw new Error(`${payload.label} router detected ${detection.kind}`);
    }
  });
  return { backend: "router", payload, operation: "router.detect", distribution };
}

async function benchmarkTokenCounter(
  payload: PayloadCase,
): Promise<PerformanceResultRow[]> {
  const cold = await measure(async () => {
    const counter = createTokenCounter({ model: "performance-calibrated" });
    if (counter.count(payload.content) <= 0) {
      throw new Error(`${payload.label} cold token counter returned no tokens`);
    }
  });
  const counter = createTokenCounter({ model: "performance-calibrated" });
  const hot = await measure(async () => {
    if (counter.count(payload.content) <= 0) {
      throw new Error(`${payload.label} hot token counter returned no tokens`);
    }
  });
  return [
    { backend: "tokenizer", payload, operation: "token.counter(cold)", distribution: cold },
    { backend: "tokenizer", payload, operation: "token.counter(hot)", distribution: hot },
  ];
}

async function benchmarkStoreAndEngine(
  backend: StoreBackend,
  payload: PayloadCase,
): Promise<PerformanceResultRow[]> {
  return withStore(backend, async (store) => {
    const engine = new NativeHeadroomCompatibleEngine(store);
    const sessionID = `perf-${backend}-${payload.label}`;
    const directInputs = new Map(
      Array.from({ length: WARMUP_RUNS + SAMPLE_RUNS }, (_, offset) => {
        const iteration = offset - WARMUP_RUNS;
        return [
          iteration,
          directPutInput(payload, sessionID, iteration),
        ] as const;
      }),
    );
    let directHash: string | undefined;
    const storePut = await measure(async (iteration) => {
      const input = directInputs.get(iteration);
      if (!input) {
        throw new Error(`missing precomputed Store input ${iteration}`);
      }
      const entry = await store.put(input);
      directHash = entry.hash;
    });
    if (!directHash) {
      throw new Error(`${backend}/${payload.label} Store put returned no hash`);
    }

    const storeGet = await measure(async () => {
      const value = await store.get(directHash!, sessionID);
      if (!value) {
        throw new Error(`${backend}/${payload.label} Store get missed its entry`);
      }
    });

    let engineHash: string | undefined;
    let engineSessionID: string | undefined;
    const compress = await measure(async (iteration) => {
      const content = `${payload.content}\nbench/iteration.ts:${100_000 + iteration}:INFO benchmark sample iteration=${iteration}`;
      engineSessionID = `${sessionID}-compress-${iteration}`;
      const result = await engine.compress({
        tool: "Bash",
        sessionID: engineSessionID,
        callID: `compress-${iteration}`,
        args: { command: "rg target", query: QUERY },
        output: content,
        ttlMs: TTL_MS,
      });
      if (!result.changed || !result.hash) {
        throw new Error(`${backend}/${payload.label} did not produce a CCR entry`);
      }
      engineHash = result.hash;
    });
    if (!engineHash) {
      throw new Error(`${backend}/${payload.label} benchmark retained no engine hash`);
    }
    if (!engineSessionID) {
      throw new Error(`${backend}/${payload.label} benchmark retained no engine session`);
    }

    const partialRetrieve = await measure(async () => {
      const value = await engine.retrieve(
        engineHash!,
        {
          mode: "query",
          query: QUERY,
          contextLines: 1,
          maxMatches: 5,
          maxChars: 4_000,
        },
        engineSessionID,
      );
      if (!value.found || !value.output.includes("benchmark needle")) {
        throw new Error(`${backend}/${payload.label} partial retrieve missed its query`);
      }
    });

    return [
      { backend, payload, operation: "store.put", distribution: storePut },
      { backend, payload, operation: "store.get", distribution: storeGet },
      { backend, payload, operation: "engine.compress", distribution: compress },
      {
        backend,
        payload,
        operation: "engine.retrieve(query)",
        distribution: partialRetrieve,
      },
    ];
  });
}

function pluginInput(directory: string) {
  return {
    client: {},
    project: { id: "performance-project" },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {},
  } as never;
}

async function benchmarkPluginHook(
  backend: StoreBackend,
  payload: PayloadCase,
): Promise<PerformanceResultRow> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-headroom-hook-perf-"));
  const plugin = await HeadroomNativePlugin(pluginInput(directory), {
    storage: {
      kind: backend,
      path: join(directory, "plugin.sqlite"),
    },
    thresholdChars: 1,
    thresholdTokens: 1,
    maxOutputChars: 512 * 1024,
  });

  try {
    const hook = plugin["tool.execute.after"];
    if (!hook) {
      throw new Error("plugin did not register tool.execute.after");
    }
    const distribution = await measure(async (iteration) => {
      const output = {
        title: "Bash",
        output: `${payload.content}\nplugin/hook.ts:${200_000 + iteration}:INFO plugin hook sample iteration=${iteration}`,
        metadata: {} as Record<string, any>,
      };
      await hook(
        {
          tool: "Bash",
          sessionID: `perf-hook-${backend}-${payload.label}-${iteration}`,
          callID: `hook-${iteration}`,
          args: { command: "rg target", query: QUERY },
        },
        output,
      );
      if (
        !output.output.includes("[Retrieve more: hash=") ||
        !output.metadata.headroom?.hash
      ) {
        throw new Error(`${backend}/${payload.label} plugin hook did not compress`);
      }
    });
    return {
      backend,
      payload,
      operation: "plugin.tool.execute.after",
      distribution,
    };
  } finally {
    await plugin.dispose?.();
    await rm(directory, { recursive: true, force: true });
  }
}

function completedPerformanceTool(input: {
  tool: "Read" | "Edit";
  sessionID: string;
  callID: string;
  filePath: string;
  output: string;
}) {
  return {
    id: `${input.callID}-part`,
    sessionID: input.sessionID,
    messageID: `${input.callID}-message`,
    type: "tool",
    callID: input.callID,
    tool: input.tool,
    state: {
      status: "completed",
      input: { filePath: input.filePath },
      output: input.output,
      title: input.tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

async function benchmarkPluginMessageTransform(
  backend: StoreBackend,
  payload: PayloadCase,
): Promise<PerformanceResultRow> {
  const directory = await mkdtemp(
    join(tmpdir(), "opencode-headroom-message-perf-"),
  );
  const plugin = await HeadroomNativePlugin(pluginInput(directory), {
    storage: {
      kind: backend,
      path: join(directory, "messages.sqlite"),
    },
  });

  try {
    const transform = plugin["experimental.chat.messages.transform"];
    if (!transform) {
      throw new Error("plugin did not register messages.transform");
    }
    const distribution = await measure(async (iteration) => {
      const sessionID = `perf-messages-${backend}-${payload.label}-${iteration}`;
      const read = completedPerformanceTool({
        tool: "Read",
        sessionID,
        callID: `read-${iteration}`,
        filePath: "src/performance.ts",
        output: payload.content,
      });
      const edit = completedPerformanceTool({
        tool: "Edit",
        sessionID,
        callID: `edit-${iteration}`,
        filePath: "src/performance.ts",
        output: "Done",
      });
      await transform(
        {},
        {
          messages: [
            { info: {}, parts: [read] },
            { info: {}, parts: [edit] },
          ],
        } as never,
      );
      if (!read.state.output.includes("is stale after a later write")) {
        throw new Error(`${backend}/${payload.label} Read lifecycle did not fold`);
      }
    });
    return {
      backend,
      payload,
      operation: "plugin.messages.transform",
      distribution,
    };
  } finally {
    await plugin.dispose?.();
    await rm(directory, { recursive: true, force: true });
  }
}

async function benchmarkSQLiteConcurrentPut(
  payload: PayloadCase,
): Promise<PerformanceResultRow> {
  const directory = await mkdtemp(
    join(tmpdir(), "opencode-headroom-sqlite-concurrent-"),
  );
  const path = join(directory, "shared.sqlite");
  const workers = Array.from(
    { length: SQLITE_CONNECTIONS },
    () => new SQLiteWorkerClient(),
  );
  try {
    for (const worker of workers) {
      await worker.call({ action: "initialize", path });
    }
    const inputs = new Map(
      Array.from({ length: WARMUP_RUNS + SAMPLE_RUNS }, (_, offset) => {
        const iteration = offset - WARMUP_RUNS;
        return [
          iteration,
          workers.map((_, connection) =>
            directPutInput(
              payload,
              `perf-sqlite-worker-${connection}`,
              iteration * SQLITE_CONNECTIONS + connection,
            ),
          ),
        ] as const;
      }),
    );
    const distribution = await measure(async (iteration) => {
      const iterationInputs = inputs.get(iteration);
      if (!iterationInputs) {
        throw new Error(`missing precomputed concurrent input ${iteration}`);
      }
      await Promise.all(
        workers.map((worker, connection) =>
          worker.call({
            action: "put",
            input: iterationInputs[connection],
          }),
        ),
      );
    });
    return {
      backend: "bun-sqlite",
      payload,
      operation: "store.put(concurrent-workers=4)",
      distribution,
    };
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.call({ action: "close" })));
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function benchmarkSQLiteColdStart(): Promise<PerformanceResultRow> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-headroom-sqlite-cold-"));
  const payload: PayloadCase = { label: "empty DB", content: "", bytes: 0 };
  try {
    const distribution = await measure(async (iteration) => {
      const store = await createBunSQLiteStore(
        join(directory, `cold-${iteration}.sqlite`),
      );
      await store.close();
    });
    return {
      backend: "bun-sqlite",
      payload,
      operation: "store.cold-start",
      distribution,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function assertP0HookLatency(
  results: PerformanceResultRow[],
): PerformanceResultRow {
  const p0 = results.find(
    (result) =>
      result.backend === "memory" &&
      result.payload.label === "10KiB" &&
      result.operation === "plugin.tool.execute.after",
  );
  if (!p0) {
    throw new Error("missing P0 memory 10KiB plugin hook result");
  }
  if (!(p0.distribution.p95 < P0_HOOK_MAX_P95_MS)) {
    throw new Error(
      `P0 memory 10KiB plugin hook p95 ${p0.distribution.p95.toFixed(3)} ms must be below ${P0_HOOK_MAX_P95_MS} ms`,
    );
  }
  return p0;
}

export function assertP0MessageTransformLatency(
  results: PerformanceResultRow[],
): PerformanceResultRow {
  const p0 = results.find(
    (result) =>
      result.backend === "memory" &&
      result.payload.label === "10KiB" &&
      result.operation === "plugin.messages.transform",
  );
  if (!p0) {
    throw new Error("missing P0 Read lifecycle message-transform result");
  }
  if (!(p0.distribution.p95 < P0_MESSAGE_TRANSFORM_MAX_P95_MS)) {
    throw new Error(
      `Read lifecycle P0 p95 ${p0.distribution.p95.toFixed(3)} ms must be below ${P0_MESSAGE_TRANSFORM_MAX_P95_MS} ms`,
    );
  }
  return p0;
}

export function assertTokenizerPerformanceReported(
  results: PerformanceResultRow[],
): void {
  if (!results.some((result) => result.operation === "token.counter(cold)")) {
    throw new Error("missing cold token-counter performance result");
  }
  if (!results.some((result) => result.operation === "token.counter(hot)")) {
    throw new Error("missing hot token-counter performance result");
  }
}

function milliseconds(value: number): string {
  return value.toFixed(3);
}

async function main(): Promise<void> {
  const payloads = TARGETS.map(({ label, bytes }) => makePayload(label, bytes));
  const results: PerformanceResultRow[] = [];

  for (const payload of payloads) {
    results.push(...(await benchmarkTokenCounter(payload)));
    results.push(await benchmarkRouter(payload));
  }
  for (const backend of ["memory", "bun-sqlite"] as const) {
    for (const payload of payloads) {
      results.push(...(await benchmarkStoreAndEngine(backend, payload)));
      results.push(await benchmarkPluginHook(backend, payload));
      results.push(await benchmarkPluginMessageTransform(backend, payload));
    }
  }
  for (const payload of payloads) {
    results.push(await benchmarkSQLiteConcurrentPut(payload));
  }
  results.push(await benchmarkSQLiteColdStart());

  const versions = process.versions as Record<string, string | undefined>;
  console.log("opencode-headroom performance baselines and P0 gate");
  console.log(
    `runtime=bun ${versions.bun ?? "unknown"} platform=${process.platform}/${process.arch} seed=0x${BASE_SEED.toString(16)} warmup=${WARMUP_RUNS} samples=${SAMPLE_RUNS}`,
  );
  console.log(
    "| Backend | Payload | Bytes | Operation | Samples | p50 (ms) | p95 (ms) | max (ms) |",
  );
  console.log("|---|---:|---:|---|---:|---:|---:|---:|");
  for (const result of results) {
    const { distribution } = result;
    console.log(
      `| ${result.backend} | ${result.payload.label} | ${result.payload.bytes} | ${result.operation} | ${distribution.samples} | ${milliseconds(distribution.p50)} | ${milliseconds(distribution.p95)} | ${milliseconds(distribution.max)} |`,
    );
  }

  const p0 = assertP0HookLatency(results);
  const messageP0 = assertP0MessageTransformLatency(results);
  assertTokenizerPerformanceReported(results);
  console.log(
    `P0 gate passed: memory 10KiB plugin.tool.execute.after p95=${milliseconds(p0.distribution.p95)}ms < ${P0_HOOK_MAX_P95_MS}ms`,
  );
  console.log(
    `P0 gate passed: memory 10KiB plugin.messages.transform p95=${milliseconds(messageP0.distribution.p95)}ms < ${P0_MESSAGE_TRANSFORM_MAX_P95_MS}ms`,
  );
  console.log(
    "SQLite concurrent-worker and cold-start rows are recorded baselines, not blocking thresholds.",
  );
}

if (import.meta.main) {
  await main();
}
