export type TokenContentClass = "prose" | "cjk" | "code" | "high_entropy";

export interface TokenCounter {
  readonly id: string;
  count(content: string): number;
}

export interface TokenCounterOptions {
  model?: string;
  tokenize?: (content: string) => number;
}

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const CODE_SIGNAL_RE =
  /(?:^|\n)\s*(?:import|export|class|interface|type|function|def|fn|const|let|var|public|private|protected)\b|=>|\{[\s\S]*\}/m;
const HIGH_ENTROPY_RE = /^[A-Za-z0-9+/=_-]+$/;

export function classifyTokenContent(content: string): TokenContentClass {
  if (!content) {
    return "prose";
  }

  const cjkCount = content.match(CJK_RE)?.length ?? 0;
  if (cjkCount / content.length >= 0.15) {
    return "cjk";
  }

  if (content.length >= 32 && HIGH_ENTROPY_RE.test(content)) {
    const categories = [/[a-z]/, /[A-Z]/, /\d/, /[+/=_-]/].filter((pattern) =>
      pattern.test(content),
    ).length;
    const uniqueRatio = new Set(content).size / content.length;
    if (categories >= 3 && uniqueRatio >= 0.25) {
      return "high_entropy";
    }
  }

  if (CODE_SIGNAL_RE.test(content)) {
    return "code";
  }

  return "prose";
}

function countProse(content: string): number {
  const pieces = content.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  return pieces.reduce((tokens, piece) => {
    if (/^[\p{L}\p{N}_]+$/u.test(piece)) {
      return tokens + Math.max(1, Math.ceil(piece.length / 4));
    }
    return tokens + 1;
  }, 0);
}

function countCjk(content: string): number {
  const cjkTokens = content.match(CJK_RE)?.length ?? 0;
  const remainder = content.replace(CJK_RE, " ");
  return cjkTokens + countProse(remainder);
}

function countCode(content: string): number {
  const pieces =
    content.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) ?? [];
  const weighted = pieces.reduce((tokens, piece) => {
    if (/^[A-Za-z_$]/.test(piece)) {
      return tokens + Math.max(1, Math.ceil(piece.length / 4));
    }
    if (/^\d/.test(piece)) {
      return tokens + Math.max(1, Math.ceil(piece.length / 3));
    }
    return tokens + 0.6;
  }, 0);
  return Math.max(1, Math.ceil(weighted));
}

class CalibratedTokenCounter implements TokenCounter {
  readonly id: string;

  constructor(model?: string) {
    this.id = `calibrated:${model?.trim() || "generic"}`;
  }

  count(content: string): number {
    if (!content) {
      return 0;
    }
    switch (classifyTokenContent(content)) {
      case "cjk":
        return countCjk(content);
      case "code":
        return countCode(content);
      case "high_entropy":
        return Math.max(1, Math.ceil(content.length / 1.6));
      case "prose":
        return Math.max(1, countProse(content));
    }
  }
}

class LocalModelTokenCounter implements TokenCounter {
  readonly id: string;

  constructor(
    model: string,
    private readonly tokenize: (content: string) => number,
  ) {
    this.id = `local:${model}`;
  }

  count(content: string): number {
    if (!content) {
      return 0;
    }
    const tokens = this.tokenize(content);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error(`local tokenizer returned invalid token count: ${tokens}`);
    }
    return tokens;
  }
}

export function createTokenCounter(
  options: TokenCounterOptions = {},
): TokenCounter {
  if (options.tokenize) {
    return new LocalModelTokenCounter(
      options.model?.trim() || "unknown",
      options.tokenize,
    );
  }
  return new CalibratedTokenCounter(options.model);
}

export const DEFAULT_TOKEN_COUNTER = createTokenCounter();

export function estimateTokens(content: string): number {
  return DEFAULT_TOKEN_COUNTER.count(content);
}
