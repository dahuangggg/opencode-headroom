import { createContentDigest } from "../store/ccr.js";

export interface SessionRepetitionOptions {
  maxSessions: number;
  maxEntriesPerSession: number;
  maxFingerprintLines: number;
  minFingerprintLines: number;
  similarityThreshold: number;
}

export interface RepetitionMatch {
  hash: string;
  kind: "exact" | "similar";
  similarity: number;
}

interface RepetitionEntry {
  hash: string;
  digest: string;
  fingerprints: ReadonlySet<string>;
  expiresAt: number;
}

const DEFAULT_OPTIONS: SessionRepetitionOptions = {
  maxSessions: 1_000,
  maxEntriesPerSession: 32,
  maxFingerprintLines: 256,
  minFingerprintLines: 8,
  similarityThreshold: 0.9,
};

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateOptions(
  options: Partial<SessionRepetitionOptions>,
): SessionRepetitionOptions {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  positiveInteger("maxSessions", resolved.maxSessions);
  positiveInteger("maxEntriesPerSession", resolved.maxEntriesPerSession);
  positiveInteger("maxFingerprintLines", resolved.maxFingerprintLines);
  positiveInteger("minFingerprintLines", resolved.minFingerprintLines);
  if (
    !Number.isFinite(resolved.similarityThreshold) ||
    resolved.similarityThreshold <= 0 ||
    resolved.similarityThreshold > 1
  ) {
    throw new Error("similarityThreshold must be greater than 0 and at most 1");
  }
  return resolved;
}

function normalizedLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function fingerprintLines(content: string, limit: number): ReadonlySet<string> {
  const hashes = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const normalized = normalizedLine(line);
    if (normalized) {
      hashes.add(createContentDigest(normalized));
    }
  }

  if (hashes.size <= limit) {
    return hashes;
  }

  // Keeping the lexicographically smallest hashes is deterministic min-hash
  // sampling: similar documents retain similar samples without raw text state.
  return new Set([...hashes].sort().slice(0, limit));
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

export class SessionRepetitionStore {
  private readonly sessions = new Map<string, RepetitionEntry[]>();
  private readonly options: SessionRepetitionOptions;

  constructor(options: Partial<SessionRepetitionOptions> = {}) {
    this.options = validateOptions(options);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  entryCount(sessionID: string): number {
    return this.sessions.get(sessionID)?.length ?? 0;
  }

  match(
    sessionID: string,
    content: string,
    now = Date.now(),
  ): RepetitionMatch | undefined {
    const entries = this.liveEntries(sessionID, now);
    if (entries.length === 0) {
      return undefined;
    }

    const digest = createContentDigest(content);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.digest === digest) {
        return { hash: entry.hash, kind: "exact", similarity: 1 };
      }
    }

    const fingerprints = fingerprintLines(
      content,
      this.options.maxFingerprintLines,
    );
    if (fingerprints.size < this.options.minFingerprintLines) {
      return undefined;
    }

    let best: RepetitionMatch | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.fingerprints.size < this.options.minFingerprintLines) {
        continue;
      }
      const similarity = jaccard(fingerprints, entry.fingerprints);
      if (
        similarity >= this.options.similarityThreshold &&
        (!best || similarity > best.similarity)
      ) {
        best = { hash: entry.hash, kind: "similar", similarity };
      }
    }
    return best;
  }

  record(
    sessionID: string,
    hash: string,
    content: string,
    expiresAt = Number.POSITIVE_INFINITY,
  ): void {
    const entries = this.liveEntries(sessionID, Date.now());
    entries.push({
      hash,
      digest: createContentDigest(content),
      fingerprints: fingerprintLines(content, this.options.maxFingerprintLines),
      expiresAt,
    });
    while (entries.length > this.options.maxEntriesPerSession) {
      entries.shift();
    }
    this.touch(sessionID, entries);
    while (this.sessions.size > this.options.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.sessions.delete(oldest);
    }
  }

  delete(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  clear(): void {
    this.sessions.clear();
  }

  private liveEntries(sessionID: string, now: number): RepetitionEntry[] {
    const current = this.sessions.get(sessionID);
    if (!current) {
      return [];
    }
    const live = current.filter((entry) => entry.expiresAt > now);
    if (live.length === 0) {
      this.sessions.delete(sessionID);
      return [];
    }
    this.touch(sessionID, live);
    return live;
  }

  private touch(sessionID: string, entries: RepetitionEntry[]): void {
    this.sessions.delete(sessionID);
    this.sessions.set(sessionID, entries);
  }
}
