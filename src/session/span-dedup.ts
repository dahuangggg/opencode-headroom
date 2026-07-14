export interface SpanDedupBlock {
  text: string;
  turn: number;
  protected?: boolean;
}

export interface SpanDedupOptions {
  minLines: number;
  minChars: number;
  maxAnchorCandidates: number;
}

export interface SpanDedupStats {
  spansFolded: number;
  linesRemoved: number;
  charsRemoved: number;
  blocks: number;
}

const DEFAULT_OPTIONS: SpanDedupOptions = {
  minLines: 3,
  minChars: 40,
  maxAnchorCandidates: 16,
};

const TRIVIAL_LINES = new Set([
  "return",
  "pass",
  "else:",
  "try:",
  "except:",
  "finally:",
  "break",
  "continue",
  "});",
  "})",
  "],",
  "),",
  '"""',
  "'''",
  "...",
]);

interface ParsedLine {
  number?: number;
  key: string;
  content: string;
}

interface AnchorCandidate {
  blockPosition: number;
  lineIndex: number;
}

interface SpanMatch extends AnchorCandidate {
  length: number;
  lineDelta: number;
}

function parseLine(line: string): ParsedLine {
  const match = /^(\d+)(:|\t)(.*)$/s.exec(line);
  if (!match) return { key: line, content: line };
  return {
    number: Number(match[1]),
    key: `${match[2]}${match[3]}`,
    content: match[3] ?? "",
  };
}

function isTrivial(line: string): boolean {
  const value = line.trim();
  return value.length < 4 || TRIVIAL_LINES.has(value);
}

function pointer(span: string[], referenceTurn: number, lineDelta: number): string {
  let anchor = span
    .map((line) => parseLine(line).content.trim())
    .find(Boolean) ?? "";
  if (anchor.length > 20) anchor = `${anchor.slice(0, 17)}...`;
  const shift = lineDelta === 0 ? "" : ` ${lineDelta > 0 ? "+" : ""}${lineDelta}L`;
  return `[↑${span.length}L same as msg ${referenceTurn}${shift}: ${JSON.stringify(anchor)}]`;
}

function indexLines(
  lines: readonly (string | null)[],
  blockPosition: number,
  anchors: Map<string, AnchorCandidate[]>,
  maxCandidates: number,
): void {
  lines.forEach((line, lineIndex) => {
    if (line === null) return;
    const parsed = parseLine(line);
    if (isTrivial(parsed.content)) return;
    const candidates = anchors.get(parsed.key) ?? [];
    if (candidates.length >= maxCandidates) return;
    candidates.push({ blockPosition, lineIndex });
    anchors.set(parsed.key, candidates);
  });
}

function longestMatch(
  current: string[],
  start: number,
  anchors: Map<string, AnchorCandidate[]>,
  corpus: readonly (readonly (string | null)[])[],
): SpanMatch | undefined {
  const line = current[start];
  if (line === undefined) return undefined;
  const candidates = anchors.get(parseLine(line).key);
  if (!candidates) return undefined;

  let best: SpanMatch | undefined;
  for (const candidate of candidates) {
    const earlier = corpus[candidate.blockPosition];
    if (!earlier) continue;
    let length = 0;
    let lineDelta: number | undefined;
    while (
      start + length < current.length &&
      candidate.lineIndex + length < earlier.length
    ) {
      const currentLine = current[start + length];
      const earlierLine = earlier[candidate.lineIndex + length];
      if (currentLine === undefined || earlierLine === undefined || earlierLine === null) {
        break;
      }
      const left = parseLine(currentLine);
      const right = parseLine(earlierLine);
      if (left.key !== right.key) break;
      if (left.number !== undefined && right.number !== undefined) {
        const delta = left.number - right.number;
        if (lineDelta === undefined) lineDelta = delta;
        else if (lineDelta !== delta) break;
      } else if (currentLine !== earlierLine) {
        break;
      }
      length += 1;
    }
    if (!best || length > best.length) {
      best = { ...candidate, length, lineDelta: lineDelta ?? 0 };
    }
  }
  return best?.length ? best : undefined;
}

function normalizeOptions(options: Partial<SpanDedupOptions>): SpanDedupOptions {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  return resolved;
}

export function deduplicateSpans(
  blocks: readonly SpanDedupBlock[],
  options: Partial<SpanDedupOptions> = {},
): { blocks: SpanDedupBlock[]; stats: SpanDedupStats } {
  const config = normalizeOptions(options);
  const anchors = new Map<string, AnchorCandidate[]>();
  const corpus: Array<Array<string | null>> = [];
  const output: SpanDedupBlock[] = [];
  const stats: SpanDedupStats = {
    spansFolded: 0,
    linesRemoved: 0,
    charsRemoved: 0,
    blocks: blocks.length,
  };

  blocks.forEach((block, blockPosition) => {
    const lines = block.text.split("\n");
    if (block.protected) {
      const verbatim = [...lines];
      indexLines(verbatim, blockPosition, anchors, config.maxAnchorCandidates);
      corpus.push(verbatim);
      output.push({ ...block });
      return;
    }

    const emitted: string[] = [];
    const verbatim: Array<string | null> = [];
    let index = 0;
    while (index < lines.length) {
      const match = longestMatch(lines, index, anchors, corpus);
      if (match && match.length >= config.minLines) {
        const span = lines.slice(index, index + match.length);
        const spanText = span.join("\n");
        const referenceTurn = blocks[match.blockPosition]?.turn;
        if (spanText.length >= config.minChars && referenceTurn !== undefined) {
          const marker = pointer(span, referenceTurn, match.lineDelta);
          if (marker.length < spanText.length) {
            emitted.push(marker);
            verbatim.push(...Array.from({ length: match.length }, () => null));
            stats.spansFolded += 1;
            stats.linesRemoved += match.length;
            stats.charsRemoved += spanText.length - marker.length;
            index += match.length;
            continue;
          }
        }
      }
      const current = lines[index] ?? "";
      emitted.push(current);
      verbatim.push(current);
      index += 1;
    }

    indexLines(verbatim, blockPosition, anchors, config.maxAnchorCandidates);
    corpus.push(verbatim);
    output.push({ ...block, text: emitted.join("\n") });
  });

  return { blocks: output, stats };
}

export function isPrefixMonotonic(
  blocks: readonly SpanDedupBlock[],
  options: Partial<SpanDedupOptions> = {},
): boolean {
  const full = deduplicateSpans(blocks, options).blocks;
  for (let length = 1; length <= blocks.length; length += 1) {
    const prefix = deduplicateSpans(blocks.slice(0, length), options).blocks;
    if (prefix.some((block, index) => block.text !== full[index]?.text)) return false;
  }
  return true;
}
