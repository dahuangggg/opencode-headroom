import { createContentDigest } from "../store/ccr.js";

export interface ContextLifecycleOptions {
  maxSessions: number;
  maxPartsPerSession: number;
  maxRepresentationCharsPerSession: number;
}

export interface ContextLifecycleStats {
  completedToolParts: number;
  liveToolParts: number;
  frozenToolParts: number;
  unidentifiedToolParts: number;
  saturatedSessions: number;
  replayedToolParts: number;
  rolledBackToolParts: number;
}

export interface ContextMutationWindow {
  readonly stats: ContextLifecycleStats;
  canMutateToolPart(part: unknown): boolean;
  commit(): void;
}

interface SentPartRecord {
  sourceDigest: string;
  sentDigest: string;
  sentOutput?: string;
}

interface SessionState {
  readonly completedParts: Map<string, SentPartRecord>;
  retainedRepresentationChars: number;
  saturated: boolean;
}

interface CompletedToolPart {
  readonly value: object;
  readonly state: { output: string };
  readonly sessionID: string;
  readonly key?: string;
  readonly messageIndex: number;
}

interface LivePartCommit {
  readonly part: CompletedToolPart;
  readonly record: SentPartRecord;
  readonly sourceOutput: string;
}

const DEFAULT_OPTIONS: ContextLifecycleOptions = {
  maxSessions: 256,
  maxPartsPerSession: 2_048,
  maxRepresentationCharsPerSession: 256_000,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function hasCacheControl(...values: unknown[]): boolean {
  return values.some((value) => {
    const metadata = record(value);
    return Boolean(metadata?.cache_control ?? metadata?.cacheControl);
  });
}

function stablePartKey(part: Record<string, unknown>): string | undefined {
  if (typeof part.id === "string" && part.id) return `part:${part.id}`;
  if (typeof part.callID === "string" && part.callID) {
    return `call:${part.callID}`;
  }
  return undefined;
}

function completedToolPart(
  value: unknown,
  messageIndex: number,
  messageInfo: Record<string, unknown> | undefined,
): CompletedToolPart | undefined {
  const part = record(value);
  const state = record(part?.state);
  if (
    part?.type !== "tool" ||
    typeof part.sessionID !== "string" ||
    !part.sessionID ||
    state?.status !== "completed" ||
    typeof state.output !== "string"
  ) {
    return undefined;
  }
  const identityMatchesMessage =
    (typeof messageInfo?.sessionID !== "string" ||
      messageInfo.sessionID === part.sessionID) &&
    (typeof messageInfo?.id !== "string" ||
      typeof part.messageID !== "string" ||
      messageInfo.id === part.messageID);
  const key = identityMatchesMessage ? stablePartKey(part) : undefined;
  return {
    value: part,
    state: state as unknown as { output: string },
    sessionID: part.sessionID,
    ...(key ? { key } : {}),
    messageIndex,
  };
}

export class ContextLifecycleManager {
  private readonly options: ContextLifecycleOptions;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: Partial<ContextLifecycleOptions> = {}) {
    const resolved = { ...DEFAULT_OPTIONS, ...options };
    positiveInteger("maxSessions", resolved.maxSessions);
    positiveInteger("maxPartsPerSession", resolved.maxPartsPerSession);
    positiveInteger(
      "maxRepresentationCharsPerSession",
      resolved.maxRepresentationCharsPerSession,
    );
    this.options = resolved;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  deleteSession(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  clear(): void {
    this.sessions.clear();
  }

  begin(
    messages: readonly { info?: unknown; parts: readonly unknown[] }[],
  ): ContextMutationWindow {
    const parts: CompletedToolPart[] = [];
    const observedSessions = new Set<string>();
    let frozenThrough = -1;

    messages.forEach((message, messageIndex) => {
      const info = record(message.info);
      if (typeof info?.sessionID === "string" && info.sessionID) {
        observedSessions.add(info.sessionID);
      }
      if (hasCacheControl(info?.metadata)) frozenThrough = messageIndex;

      message.parts.forEach((part) => {
        const candidate = record(part);
        const state = record(candidate?.state);
        if (hasCacheControl(candidate?.metadata, state?.metadata)) {
          frozenThrough = Math.max(frozenThrough, messageIndex);
        }
        if (typeof candidate?.sessionID === "string" && candidate.sessionID) {
          observedSessions.add(candidate.sessionID);
        }
        const completed = completedToolPart(part, messageIndex, info);
        if (completed) parts.push(completed);
      });
    });

    const firstObservedSessions = new Set<string>();
    for (const sessionID of observedSessions) {
      const existing = this.sessions.get(sessionID);
      if (existing) {
        this.touch(sessionID, existing);
      } else {
        firstObservedSessions.add(sessionID);
        this.touch(sessionID, {
          completedParts: new Map(),
          retainedRepresentationChars: 0,
          saturated: false,
        });
      }
    }

    const liveParts = new WeakSet<object>();
    const saturatedSessions = new Set<string>();
    const liveCommits: LivePartCommit[] = [];
    const bySession = new Map<string, CompletedToolPart[]>();
    for (const part of parts) {
      const sessionParts = bySession.get(part.sessionID) ?? [];
      sessionParts.push(part);
      bySession.set(part.sessionID, sessionParts);
    }
    let replayedToolParts = 0;

    for (const [sessionID, sessionParts] of bySession) {
      const session = this.sessions.get(sessionID);
      if (!session) continue;
      const keyCounts = new Map<string, number>();
      for (const part of sessionParts) {
        if (part.key) keyCounts.set(part.key, (keyCounts.get(part.key) ?? 0) + 1);
      }

      for (const part of sessionParts) {
        if (!part.key) continue;
        const existing = session.completedParts.get(part.key);
        if (!existing) continue;
        const currentDigest = createContentDigest(part.state.output);
        if (existing.sentOutput && currentDigest === existing.sourceDigest) {
          part.state.output = existing.sentOutput;
          replayedToolParts += 1;
        } else if (currentDigest !== existing.sentDigest) {
          session.retainedRepresentationChars -= existing.sentOutput?.length ?? 0;
          existing.sourceDigest = currentDigest;
          existing.sentDigest = currentDigest;
          delete existing.sentOutput;
        }
      }

      const unseenKeys = new Set(
        sessionParts
          .map((part) => part.key)
          .filter(
            (key): key is string =>
              Boolean(key) && !session.completedParts.has(key!),
          ),
      );

      if (
        session.saturated ||
        session.completedParts.size + unseenKeys.size >
          this.options.maxPartsPerSession
      ) {
        session.saturated = true;
        saturatedSessions.add(sessionID);
        continue;
      }

      for (const part of sessionParts) {
        if (!part.key || !unseenKeys.has(part.key)) continue;
        const sourceDigest = createContentDigest(part.state.output);
        const sent: SentPartRecord = {
          sourceDigest,
          sentDigest: sourceDigest,
        };
        session.completedParts.set(part.key, sent);

        if (
          !firstObservedSessions.has(sessionID) &&
          keyCounts.get(part.key) === 1 &&
          part.messageIndex > frozenThrough
        ) {
          liveParts.add(part.value);
          liveCommits.push({
            part,
            record: sent,
            sourceOutput: part.state.output,
          });
        }
      }

      if (session.saturated) saturatedSessions.add(sessionID);
    }

    const stats: ContextLifecycleStats = {
      completedToolParts: parts.length,
      liveToolParts: parts.filter((part) => liveParts.has(part.value)).length,
      frozenToolParts: parts.filter((part) => !liveParts.has(part.value)).length,
      unidentifiedToolParts: parts.filter((part) => !part.key).length,
      saturatedSessions: saturatedSessions.size,
      replayedToolParts,
      rolledBackToolParts: 0,
    };
    let committed = false;
    return {
      stats,
      canMutateToolPart: (part) =>
        Boolean(part && typeof part === "object" && liveParts.has(part)),
      commit: () => {
        if (committed) return;
        committed = true;
        for (const item of liveCommits) {
          const sentOutput = item.part.state.output;
          const sentDigest = createContentDigest(sentOutput);
          const sourceDigest = createContentDigest(item.sourceOutput);
          const session = this.sessions.get(item.part.sessionID);
          const retainedChars = sentDigest === sourceDigest ? 0 : sentOutput.length;
          if (
            !session ||
            session.retainedRepresentationChars + retainedChars >
              this.options.maxRepresentationCharsPerSession
          ) {
            item.part.state.output = item.sourceOutput;
            item.record.sourceDigest = sourceDigest;
            item.record.sentDigest = sourceDigest;
            delete item.record.sentOutput;
            stats.rolledBackToolParts += 1;
            continue;
          }

          item.record.sourceDigest = sourceDigest;
          item.record.sentDigest = sentDigest;
          if (sentDigest === sourceDigest) {
            delete item.record.sentOutput;
          } else {
            item.record.sentOutput = sentOutput;
            session.retainedRepresentationChars += retainedChars;
          }
        }
      },
    };
  }

  private touch(sessionID: string, state: SessionState): void {
    this.sessions.delete(sessionID);
    this.sessions.set(sessionID, state);
    while (this.sessions.size > this.options.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}
