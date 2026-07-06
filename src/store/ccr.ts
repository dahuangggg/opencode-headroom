import { createHash } from "node:crypto";

import { MemoryCCRStore } from "./memory.js";
import type { CCRStore } from "./types.js";

export interface StoreFactoryOptions {
  kind: "auto" | "memory" | "bun-sqlite";
  path: string;
}

export function createContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

export async function createCCRStore(
  options: StoreFactoryOptions,
): Promise<CCRStore> {
  if (options.kind === "memory") {
    return new MemoryCCRStore();
  }

  if (options.kind === "bun-sqlite") {
    const mod = await import("./sqlite-bun.js");
    return mod.createBunSQLiteStore(options.path);
  }

  try {
    const mod = await import("./sqlite-bun.js");
    return await mod.createBunSQLiteStore(options.path);
  } catch {
    return new MemoryCCRStore();
  }
}
