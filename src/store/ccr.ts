import { createHash } from "node:crypto";

import { MemoryCCRStore } from "./memory.js";
import type { CCRStore } from "./types.js";

export interface StoreFactoryOptions {
  kind: "auto" | "memory" | "bun-sqlite";
  path: string;
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
    hash.update("js-string-utf16le\0", "utf8");
    hash.update(Buffer.from(content, "utf16le"));
  } else {
    hash.update(content, "utf8");
  }
  return hash.digest("hex").slice(0, 24);
}

export function createCollisionHash(content: string, attempt: number): string {
  const hash = createHash("sha256");
  hash.update("opencode-headroom-collision\0", "utf8");
  hash.update(String(attempt), "utf8");
  hash.update("\0", "utf8");
  hash.update(Buffer.from(content, "utf16le"));
  return hash.digest("hex").slice(0, 24);
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
