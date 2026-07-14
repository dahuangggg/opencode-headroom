export interface SessionIntentOptions {
  maxSessions: number;
  maxChars: number;
}

interface TextPartLike {
  type?: unknown;
  text?: unknown;
  ignored?: unknown;
  synthetic?: unknown;
}

const DEFAULT_OPTIONS: SessionIntentOptions = {
  maxSessions: 1_000,
  maxChars: 2_000,
};

export class SessionIntentStore {
  private readonly values = new Map<string, string>();
  private readonly options: SessionIntentOptions;

  constructor(options: Partial<SessionIntentOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get size(): number {
    return this.values.size;
  }

  update(sessionID: string, parts: readonly unknown[]): void {
    const text = parts
      .filter(
        (part): part is TextPartLike =>
          typeof part === "object" && part !== null,
      )
      .filter(
        (part) =>
          part.type === "text" &&
          part.ignored !== true &&
          part.synthetic !== true &&
          typeof part.text === "string",
      )
      .map((part) => String(part.text).trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, this.options.maxChars);
    if (!text) {
      return;
    }

    this.values.delete(sessionID);
    this.values.set(sessionID, text);
    while (this.values.size > this.options.maxSessions) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.values.delete(oldest);
    }
  }

  get(sessionID: string): string | undefined {
    return this.values.get(sessionID);
  }

  delete(sessionID: string): void {
    this.values.delete(sessionID);
  }

  clear(): void {
    this.values.clear();
  }
}
