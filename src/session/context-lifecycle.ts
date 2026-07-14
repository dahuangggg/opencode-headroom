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
  invalidatedReplayToolParts: number;
}

export interface ReplayedToolPart {
  readonly sourceOutput: string;
  readonly sentOutput: string;
}

export interface ContextMutationWindow {
  readonly stats: ContextLifecycleStats;
  canMutateToolPart(part: unknown): boolean;
  replayForToolPart(part: unknown): ReplayedToolPart | undefined;
  invalidateReplayForToolPart(part: unknown): boolean;
  commit(): void;
  abort(): void;
}

interface SentPartRecord {
  sourceDigest: string;
  sentDigest: string;
  sentOutput?: string;
}

interface SessionState {
  readonly completedParts: Map<string, SentPartRecord>;
  retainedRepresentationChars: number;
  retainedRepresentationCount: number;
  saturated: boolean;
  openWindows: number;
  conflictVersion: number;
}

interface CompletedToolPart {
  readonly value: object;
  readonly state: { output: string };
  readonly sessionID?: string;
  readonly messageID?: string;
  readonly key?: string;
  readonly messageIndex: number;
}

interface LivePartCommit {
  readonly part: CompletedToolPart;
  readonly record: SentPartRecord;
  readonly sourceOutput: string;
  readonly sessionID: string;
  readonly key: string;
  readonly session: SessionState;
  readonly conflictVersion: number;
}

interface ReplayedPartState extends ReplayedToolPart {
  readonly part: CompletedToolPart;
  readonly record: SentPartRecord;
  readonly sessionID: string;
  readonly key: string;
  readonly session: SessionState;
}

interface WindowSessionState {
  readonly session: SessionState;
  readonly conflictVersion: number;
}

interface LivePartWindow extends WindowSessionState {
  readonly sessionID: string;
}

interface TransformLockAcquisition {
  readonly rejectedSessionIDs: ReadonlySet<string>;
  release(): void;
}

interface MessageIdentity {
  readonly id: string;
  readonly sessionID: string;
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function messageIdentity(
  info: Record<string, unknown> | undefined,
): MessageIdentity | undefined {
  if (!nonEmptyString(info?.id) || !nonEmptyString(info.sessionID)) {
    return undefined;
  }
  return { id: info.id, sessionID: info.sessionID };
}

function completedToolPart(
  value: unknown,
  messageIndex: number,
  identity: MessageIdentity | undefined,
): CompletedToolPart | undefined {
  const part = record(value);
  const state = record(part?.state);
  if (
    part?.type !== "tool" ||
    state?.status !== "completed" ||
    typeof state.output !== "string"
  ) {
    return undefined;
  }
  const identityMatchesMessage = Boolean(
    identity &&
      nonEmptyString(part.sessionID) &&
      part.sessionID === identity.sessionID &&
      nonEmptyString(part.messageID) &&
      part.messageID === identity.id &&
      nonEmptyString(part.id) &&
      nonEmptyString(part.callID),
  );
  const key = identityMatchesMessage
    ? JSON.stringify([identity!.id, part.id, part.callID])
    : undefined;
  return {
    value: part,
    state: state as unknown as { output: string },
    ...(identityMatchesMessage
      ? {
          sessionID: identity!.sessionID,
          messageID: identity!.id,
          key: key!,
        }
      : {}),
    messageIndex,
  };
}

export class ContextLifecycleManager {
  private readonly options: ContextLifecycleOptions;
  private readonly sessions = new Map<string, SessionState>();
  private readonly transformTails = new Map<string, Promise<void>>();
  private readonly exclusiveSessions = new Set<string>();
  private cleanupTail: Promise<void> = Promise.resolve();
  private closing = false;

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

  get activeTransformSessionCount(): number {
    return this.transformTails.size;
  }

  deleteSession(sessionID: string): void {
    this.sessions.delete(sessionID);
  }

  clear(): void {
    this.sessions.clear();
  }

  async run<T>(
    messages: readonly { info?: unknown; parts: readonly unknown[] }[],
    transform: (window: ContextMutationWindow) => Promise<T> | T,
  ): Promise<T> {
    const lock = await this.acquireTransformLocks(messages);
    let window: ContextMutationWindow | undefined;
    let succeeded = false;
    try {
      if (lock.rejectedSessionIDs.size > 0) {
        throw new Error("Context lifecycle transform capacity unavailable");
      }
      window = this.begin(messages, lock.rejectedSessionIDs);
      const result = await transform(window);
      succeeded = true;
      return result;
    } finally {
      try {
        if (succeeded) window?.commit();
        else window?.abort();
      } finally {
        lock.release();
      }
    }
  }

  async runSessionExclusive<T>(
    sessionID: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (!nonEmptyString(sessionID)) {
      throw new Error("sessionID must be non-empty");
    }
    if (this.closing) {
      throw new Error("Context lifecycle is closing");
    }
    const waitForCleanup = this.cleanupTail.catch(() => undefined);
    let releaseCleanup!: () => void;
    const cleanupTicket = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupTail = waitForCleanup.then(() => cleanupTicket);
    this.cleanupTail = cleanupTail;
    await waitForCleanup;
    this.exclusiveSessions.add(sessionID);
    try {
      const tail = this.transformTails.get(sessionID);
      if (tail) await tail.catch(() => undefined);
      return await operation();
    } finally {
      this.exclusiveSessions.delete(sessionID);
      releaseCleanup();
      if (this.cleanupTail === cleanupTail) {
        this.cleanupTail = Promise.resolve();
      }
    }
  }

  async closeAndDrain(): Promise<void> {
    this.closing = true;
    await Promise.all(
      [this.cleanupTail, ...this.transformTails.values()].map((tail) =>
        tail.catch(() => undefined),
      ),
    );
  }

  begin(
    messages: readonly { info?: unknown; parts: readonly unknown[] }[],
    rejectedSessionIDs: ReadonlySet<string> = new Set(),
  ): ContextMutationWindow {
    const parts: CompletedToolPart[] = [];
    const observedSessions = new Set<string>();
    let frozenThrough = -1;

    messages.forEach((message, messageIndex) => {
      const info = record(message.info);
      const identity = messageIdentity(info);
      if (identity) observedSessions.add(identity.sessionID);
      if (hasCacheControl(info?.metadata)) frozenThrough = messageIndex;

      message.parts.forEach((part) => {
        const candidate = record(part);
        const state = record(candidate?.state);
        if (hasCacheControl(candidate?.metadata, state?.metadata)) {
          frozenThrough = Math.max(frozenThrough, messageIndex);
        }
        const completed = completedToolPart(part, messageIndex, identity);
        if (completed) parts.push(completed);
      });
    });

    const firstObservedSessions = new Set<string>();
    const capacityRejectedSessions = new Set<string>(rejectedSessionIDs);
    const windowSessions = new Map<string, WindowSessionState>();
    const overlappingSessions = new Set<string>();
    for (const sessionID of observedSessions) {
      if (rejectedSessionIDs.has(sessionID)) continue;
      const existing = this.sessions.get(sessionID);
      if (existing) {
        this.touchExisting(sessionID, existing);
      } else {
        const created = this.createSession(sessionID);
        if (created) firstObservedSessions.add(sessionID);
        else capacityRejectedSessions.add(sessionID);
      }

      const session = this.sessions.get(sessionID);
      if (!session) continue;
      if (session.openWindows > 0) {
        session.conflictVersion += 1;
        overlappingSessions.add(sessionID);
      }
      session.openWindows += 1;
      windowSessions.set(sessionID, {
        session,
        conflictVersion: session.conflictVersion,
      });
    }

    const liveParts = new WeakSet<object>();
    const livePartWindows = new WeakMap<object, LivePartWindow>();
    const saturatedSessions = new Set(capacityRejectedSessions);
    const liveCommits: LivePartCommit[] = [];
    const replayedParts = new WeakMap<object, ReplayedPartState>();
    const bySession = new Map<string, CompletedToolPart[]>();
    for (const part of parts) {
      if (!part.sessionID || !part.key) continue;
      const sessionParts = bySession.get(part.sessionID) ?? [];
      sessionParts.push(part);
      bySession.set(part.sessionID, sessionParts);
    }
    let replayedToolParts = 0;

    for (const [sessionID, sessionParts] of bySession) {
      const session = this.sessions.get(sessionID);
      const windowSession = windowSessions.get(sessionID);
      if (!session || windowSession?.session !== session) continue;
      const keyCounts = new Map<string, number>();
      for (const part of sessionParts) {
        if (part.key) keyCounts.set(part.key, (keyCounts.get(part.key) ?? 0) + 1);
      }

      for (const part of sessionParts) {
        if (!part.key) continue;
        const existing = session.completedParts.get(part.key);
        if (!existing) continue;
        const currentDigest = createContentDigest(part.state.output);
        if (
          existing.sentOutput !== undefined &&
          currentDigest === existing.sourceDigest
        ) {
          const sourceOutput = part.state.output;
          try {
            part.state.output = existing.sentOutput;
          } catch {
            continue;
          }
          replayedParts.set(part.value, {
            part,
            record: existing,
            sessionID,
            key: part.key,
            session,
            sourceOutput,
            sentOutput: existing.sentOutput,
          });
          replayedToolParts += 1;
        } else if (currentDigest !== existing.sentDigest) {
          if (existing.sentOutput !== undefined) {
            session.retainedRepresentationChars = Math.max(
              0,
              session.retainedRepresentationChars - existing.sentOutput.length,
            );
            session.retainedRepresentationCount = Math.max(
              0,
              session.retainedRepresentationCount - 1,
            );
          }
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
          !overlappingSessions.has(sessionID) &&
          keyCounts.get(part.key) === 1 &&
          part.messageIndex > frozenThrough
        ) {
          liveParts.add(part.value);
          livePartWindows.set(part.value, { sessionID, ...windowSession });
          liveCommits.push({
            part,
            record: sent,
            sourceOutput: part.state.output,
            sessionID,
            key: part.key,
            session,
            conflictVersion: windowSession.conflictVersion,
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
      invalidatedReplayToolParts: 0,
    };
    let finalized = false;
    const closeWindow = () => {
      for (const { session } of windowSessions.values()) {
        session.openWindows = Math.max(0, session.openWindows - 1);
      }
    };
    const rollbackLivePart = (item: LivePartCommit) => {
      try {
        item.part.state.output = item.sourceOutput;
      } catch {
        // Host parts are mutable; if a hostile object is not, bookkeeping
        // still must not be committed for a representation we cannot replay.
      }
      const sourceDigest = createContentDigest(item.sourceOutput);
      item.record.sourceDigest = sourceDigest;
      item.record.sentDigest = sourceDigest;
      delete item.record.sentOutput;
      stats.rolledBackToolParts += 1;
    };
    const liveCommitIsCurrent = (item: LivePartCommit) =>
      this.sessions.get(item.sessionID) === item.session &&
      item.session.completedParts.get(item.key) === item.record &&
      item.session.conflictVersion === item.conflictVersion;
    return {
      stats,
      canMutateToolPart: (part) => {
        if (!part || typeof part !== "object" || !liveParts.has(part)) {
          return false;
        }
        const owningWindow = livePartWindows.get(part);
        return Boolean(
          owningWindow &&
            this.sessions.get(owningWindow.sessionID) === owningWindow.session &&
            owningWindow.session.conflictVersion ===
              owningWindow.conflictVersion,
        );
      },
      replayForToolPart: (part) =>
        part && typeof part === "object"
          ? replayedParts.get(part)
          : undefined,
      invalidateReplayForToolPart: (part) => {
        if (!part || typeof part !== "object") return false;
        const replayed = replayedParts.get(part);
        if (!replayed) return false;
        try {
          replayed.part.state.output = replayed.sourceOutput;
        } catch {
          return false;
        }
        replayedParts.delete(part);
        const current =
          this.sessions.get(replayed.sessionID) === replayed.session &&
          replayed.session.completedParts.get(replayed.key) === replayed.record;
        if (current && replayed.record.sentOutput !== undefined) {
          replayed.session.retainedRepresentationChars = Math.max(
            0,
            replayed.session.retainedRepresentationChars -
              replayed.record.sentOutput.length,
          );
          replayed.session.retainedRepresentationCount = Math.max(
            0,
            replayed.session.retainedRepresentationCount - 1,
          );
        }
        const sourceDigest = createContentDigest(replayed.sourceOutput);
        replayed.record.sourceDigest = sourceDigest;
        replayed.record.sentDigest = sourceDigest;
        delete replayed.record.sentOutput;
        stats.invalidatedReplayToolParts += 1;
        return true;
      },
      commit: () => {
        if (finalized) return;
        finalized = true;
        try {
          for (const item of liveCommits) {
            try {
              const sentOutput: unknown = item.part.state.output;
              if (
                typeof sentOutput !== "string" ||
                !liveCommitIsCurrent(item)
              ) {
                rollbackLivePart(item);
                continue;
              }
              const sentDigest = createContentDigest(sentOutput);
              const sourceDigest = createContentDigest(item.sourceOutput);
              const retainedChars =
                sentDigest === sourceDigest ? 0 : sentOutput.length;
              if (
                item.session.retainedRepresentationChars + retainedChars >
                this.options.maxRepresentationCharsPerSession
              ) {
                rollbackLivePart(item);
                continue;
              }

              item.record.sourceDigest = sourceDigest;
              item.record.sentDigest = sentDigest;
              if (sentDigest === sourceDigest) {
                delete item.record.sentOutput;
              } else {
                item.record.sentOutput = sentOutput;
                item.session.retainedRepresentationChars += retainedChars;
                item.session.retainedRepresentationCount += 1;
              }
            } catch {
              rollbackLivePart(item);
            }
          }
        } finally {
          closeWindow();
        }
      },
      abort: () => {
        if (finalized) return;
        finalized = true;
        try {
          for (const item of liveCommits) rollbackLivePart(item);
        } finally {
          closeWindow();
        }
      },
    };
  }

  private touchExisting(sessionID: string, state: SessionState): void {
    this.sessions.delete(sessionID);
    this.sessions.set(sessionID, state);
  }

  private createSession(sessionID: string): SessionState | undefined {
    if (this.sessions.size >= this.options.maxSessions) {
      let evictableSessionID: string | undefined;
      for (const [candidateID, candidate] of this.sessions) {
        if (
          candidate.retainedRepresentationCount === 0 &&
          candidate.openWindows === 0
        ) {
          evictableSessionID = candidateID;
          break;
        }
      }
      if (!evictableSessionID) return undefined;
      this.sessions.delete(evictableSessionID);
    }

    const state: SessionState = {
      completedParts: new Map(),
      retainedRepresentationChars: 0,
      retainedRepresentationCount: 0,
      saturated: false,
      openWindows: 0,
      conflictVersion: 0,
    };
    this.sessions.set(sessionID, state);
    return state;
  }

  private async acquireTransformLocks(
    messages: readonly { info?: unknown }[],
  ): Promise<TransformLockAcquisition> {
    const sessionIDs = [
      ...new Set(
        messages
          .map((message) => messageIdentity(record(message.info))?.sessionID)
          .filter((value): value is string => Boolean(value)),
      ),
    ].sort();
    const rejectedSessionIDs = new Set<string>();
    let acceptedSessionIDs: string[] = [];

    for (;;) {
      if (this.closing) {
        throw new Error("Context lifecycle is closing");
      }
      const candidates = sessionIDs.filter((sessionID) => {
        if (this.exclusiveSessions.has(sessionID)) {
          rejectedSessionIDs.add(sessionID);
          return false;
        }
        return true;
      });
      const existing = candidates.filter((sessionID) =>
        this.transformTails.has(sessionID),
      );
      const missing = candidates.filter(
        (sessionID) => !this.transformTails.has(sessionID),
      );
      const tracked = missing.filter((sessionID) =>
        this.sessions.has(sessionID),
      );
      const untracked = missing.filter(
        (sessionID) => !this.sessions.has(sessionID),
      );
      const available = this.options.maxSessions - this.transformTails.size;
      if (tracked.length > available) {
        const tails = [...this.transformTails.values()];
        if (tails.length === 0) continue;
        await Promise.race(tails.map((tail) => tail.catch(() => undefined)));
        continue;
      }

      const acceptedUntracked = untracked.slice(
        0,
        Math.max(0, available - tracked.length),
      );
      for (const sessionID of untracked.slice(acceptedUntracked.length)) {
        rejectedSessionIDs.add(sessionID);
      }
      acceptedSessionIDs = [...existing, ...tracked, ...acceptedUntracked];
      break;
    }

    const reservations: Array<{
      sessionID: string;
      tail: Promise<void>;
      waitFor: Promise<void>;
      release: () => void;
    }> = [];

    for (const sessionID of acceptedSessionIDs) {
      const waitFor = (this.transformTails.get(sessionID) ?? Promise.resolve())
        .catch(() => undefined);
      let release!: () => void;
      const ticket = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = waitFor.then(() => ticket);
      this.transformTails.set(sessionID, tail);
      reservations.push({ sessionID, tail, waitFor, release });
    }

    await Promise.all(reservations.map(({ waitFor }) => waitFor));
    return {
      rejectedSessionIDs,
      release: () => {
        for (const reservation of reservations) {
          reservation.release();
          if (
            this.transformTails.get(reservation.sessionID) === reservation.tail
          ) {
            this.transformTails.delete(reservation.sessionID);
          }
        }
      },
    };
  }
}
