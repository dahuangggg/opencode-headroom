import type { ContentKind } from "../compressors/types.js";

export type LosslessTransform = "runs" | "search_heading";

export type LosslessCompaction =
  | { changed: false; output: string }
  | { changed: true; output: string; transform: LosslessTransform };

const RUN_MARKER_RE = /^\.\.\. \(repeated (\d+) times\)$/;
const MAX_RUN_EXPANSION = 250_000;
const GREP_ROW_RE = /^(?<path>[^\n:]+):(?<line>\d+):(?<content>.*)$/;
const HEADING_ROW_RE = /^(?<line>\d+):(?<content>.*)$/;

function splitKeepTrailing(text: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  if (!text) {
    return { lines: [], trailingNewline: false };
  }
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  const output = lines.join("\n");
  return trailingNewline ? `${output}\n` : output;
}

export function collapseRuns(text: string): string {
  const { lines, trailingNewline } = splitKeepTrailing(text);
  if (lines.length === 0) {
    return text;
  }

  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) {
      end += 1;
    }
    const count = end - index;
    output.push(lines[index] ?? "");
    if (count >= 2) {
      output.push(`... (repeated ${count} times)`);
    }
    index = end;
  }
  return joinLines(output, trailingNewline);
}

export function expandRuns(text: string): string {
  const { lines, trailingNewline } = splitKeepTrailing(text);
  if (lines.length === 0) {
    return text;
  }

  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const marker = lines[index + 1];
    const match = marker === undefined ? undefined : RUN_MARKER_RE.exec(marker);
    if (match) {
      const count = Number(match[1]);
      if (
        Number.isSafeInteger(count) &&
        count >= 2 &&
        count <= MAX_RUN_EXPANSION
      ) {
        for (let occurrence = 0; occurrence < count; occurrence += 1) {
          output.push(line);
        }
        index += 2;
        continue;
      }
    }
    output.push(line);
    index += 1;
  }
  return joinLines(output, trailingNewline);
}

export function searchHeading(text: string): string {
  const { lines, trailingNewline } = splitKeepTrailing(text);
  if (lines.length === 0) {
    return text;
  }

  const output: string[] = [];
  let currentPath: string | undefined;
  for (const line of lines) {
    const match = GREP_ROW_RE.exec(line);
    const path = match?.groups?.path;
    const lineNumber = match?.groups?.line;
    const content = match?.groups?.content;
    if (path && lineNumber && content !== undefined) {
      if (path !== currentPath) {
        output.push(path);
        currentPath = path;
      }
      output.push(`${lineNumber}:${content}`);
      continue;
    }
    output.push(line);
    currentPath = undefined;
  }
  return joinLines(output, trailingNewline);
}

export function searchUnheading(text: string): string {
  const { lines, trailingNewline } = splitKeepTrailing(text);
  if (lines.length === 0) {
    return text;
  }

  const output: string[] = [];
  let currentPath: string | undefined;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const data = HEADING_ROW_RE.exec(line);
    const lineNumber = data?.groups?.line;
    const content = data?.groups?.content;
    if (currentPath && lineNumber && content !== undefined) {
      output.push(`${currentPath}:${lineNumber}:${content}`);
      index += 1;
      continue;
    }
    if (!data && HEADING_ROW_RE.test(lines[index + 1] ?? "")) {
      currentPath = line;
      index += 1;
      continue;
    }
    currentPath = undefined;
    output.push(line);
    index += 1;
  }
  return joinLines(output, trailingNewline);
}

export function compactLossless(
  content: string,
  kind: ContentKind,
): LosslessCompaction {
  if (!content) {
    return { changed: false, output: content };
  }

  try {
    if (kind === "search") {
      const output = searchHeading(content);
      if (output.length < content.length && searchUnheading(output) === content) {
        return { changed: true, output, transform: "search_heading" };
      }
    }
    if (kind === "log" || kind === "text") {
      const output = collapseRuns(content);
      if (output.length < content.length && expandRuns(output) === content) {
        return { changed: true, output, transform: "runs" };
      }
    }
  } catch {
    return { changed: false, output: content };
  }
  return { changed: false, output: content };
}
