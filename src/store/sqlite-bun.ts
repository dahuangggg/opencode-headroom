import { MemoryCCRStore } from "./memory.js";
import type { CCRStore } from "./types.js";

export async function createBunSQLiteStore(_path: string): Promise<CCRStore> {
  return new MemoryCCRStore();
}
