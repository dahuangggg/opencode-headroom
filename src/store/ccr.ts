import { createHash } from "node:crypto";

import { MemoryCCRStore } from "./memory.js";
import type { CCRStore, CCRStoreOptions } from "./types.js";

export interface StoreFactoryOptions extends CCRStoreOptions {
  kind: "auto" | "memory" | "bun-sqlite";
  path: string;
}

/** Internal hashing seam used by Store contract tests to force collisions. */
export interface CCRHashProvider {
  contentHash(content: string): string;
  contentDigest(content: string): string;
  collisionHash(content: string, attempt: number): string;
}

function hasLoneSurrogate(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }

  return false;
}

export function createContentHash(content: string): string {
  const hash = createHash("sha256");
  if (hasLoneSurrogate(content)) {
    // 0xff can never occur in valid UTF-8. This makes the UTF-16LE fallback
    // domain disjoint from every byte sequence produced by the normal branch.
    hash.update(Buffer.from([0xff, 0x48, 0x52, 0x01, 0x00]));
    hash.update(Buffer.from(content, "utf16le"));
  } else {
    hash.update(content, "utf8");
  }
  return hash.digest("hex").slice(0, 24);
}

export function createContentDigest(content: string): string {
  const hash = createHash("sha256");
  hash.update("opencode-headroom-content\0", "utf8");
  hash.update(Buffer.from(content, "utf16le"));
  return hash.digest("hex");
}

export function createCollisionHash(content: string, attempt: number): string {
  const hash = createHash("sha256");
  hash.update("opencode-headroom-collision\0", "utf8");
  hash.update(String(attempt), "utf8");
  hash.update("\0", "utf8");
  hash.update(Buffer.from(content, "utf16le"));
  return hash.digest("hex").slice(0, 24);
}

export const DEFAULT_CCR_HASH_PROVIDER: CCRHashProvider = {
  contentHash: createContentHash,
  contentDigest: createContentDigest,
  collisionHash: createCollisionHash,
};

export async function createCCRStore(
  options: StoreFactoryOptions,
): Promise<CCRStore> {
  if (options.kind === "memory") {
    return new MemoryCCRStore(
      undefined,
      { maxEntries: options.maxEntries },
      { requested: "memory", active: "memory" },
    );
  }

  if (options.kind === "bun-sqlite") {
    const mod = await import("./sqlite-bun.js");
    return mod.createBunSQLiteStore(
      options.path,
      {
        maxEntries: options.maxEntries,
        busyTimeoutMs: options.busyTimeoutMs,
      },
      { requested: "bun-sqlite", active: "bun-sqlite" },
    );
  }

  if ((globalThis as { Bun?: unknown }).Bun === undefined) {
    return new MemoryCCRStore(
      undefined,
      { maxEntries: options.maxEntries },
      {
        requested: "auto",
        active: "memory",
        fallbackReason: "unsupported_runtime",
      },
    );
  }

  const mod = await import("./sqlite-bun.js");
  return mod.createBunSQLiteStore(
    options.path,
    {
      maxEntries: options.maxEntries,
      busyTimeoutMs: options.busyTimeoutMs,
    },
    { requested: "auto", active: "bun-sqlite" },
  );
}
