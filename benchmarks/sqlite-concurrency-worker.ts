import { parentPort } from "node:worker_threads";

import { createBunSQLiteStore } from "../src/store/sqlite-bun.js";
import type { CCRPutInput, CCRStore } from "../src/store/types.js";

type Request =
  | { id: number; action: "initialize"; path: string }
  | { id: number; action: "put"; input: CCRPutInput }
  | { id: number; action: "close" };

let store: CCRStore | undefined;

parentPort?.on("message", async (request: Request) => {
  try {
    if (request.action === "initialize") {
      store = await createBunSQLiteStore(request.path);
    } else if (request.action === "put") {
      if (!store) {
        throw new Error("SQLite worker was not initialized");
      }
      await store.put(request.input);
    } else {
      await store?.close();
      store = undefined;
    }
    parentPort?.postMessage({ id: request.id, ok: true });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
