import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

const MIN_LINES_FOR_COMPRESSION = 50;
const MAX_CONTEXT_LINES = 2;
const MAX_COMPRESSION_RATIO = 0.8;

interface DiffHunk {
  header: string;
  lines: string[];
}

interface DiffFile {
  header: string[];
  hunks: DiffHunk[];
}

interface ParsedDiff {
  prelude: string[];
  files: DiffFile[];
}

function isFileHeader(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("diff --cc ") ||
    line.startsWith("diff --combined ")
  );
}

function isHunkHeader(line: string): boolean {
  return /^@@@?\s/.test(line);
}

function parseDiff(lines: string[]): ParsedDiff | undefined {
  const firstFile = lines.findIndex(isFileHeader);
  if (firstFile < 0) {
    return undefined;
  }

  const files: DiffFile[] = [];
  let index = firstFile;
  while (index < lines.length) {
    if (!isFileHeader(lines[index] ?? "")) {
      return undefined;
    }

    const header: string[] = [lines[index] ?? ""];
    index += 1;
    while (
      index < lines.length &&
      !isFileHeader(lines[index] ?? "") &&
      !isHunkHeader(lines[index] ?? "")
    ) {
      header.push(lines[index] ?? "");
      index += 1;
    }

    const hunks: DiffHunk[] = [];
    while (index < lines.length && !isFileHeader(lines[index] ?? "")) {
      const hunkHeader = lines[index] ?? "";
      if (!isHunkHeader(hunkHeader)) {
        return undefined;
      }
      index += 1;
      const hunkLines: string[] = [];
      while (
        index < lines.length &&
        !isFileHeader(lines[index] ?? "") &&
        !isHunkHeader(lines[index] ?? "")
      ) {
        hunkLines.push(lines[index] ?? "");
        index += 1;
      }
      hunks.push({ header: hunkHeader, lines: hunkLines });
    }
    files.push({ header, hunks });
  }

  return files.some((file) => file.hunks.length > 0)
    ? { prelude: lines.slice(0, firstFile), files }
    : undefined;
}

function isChangeLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

function trimHunkContext(hunk: DiffHunk): DiffHunk {
  const changes = hunk.lines
    .map((line, index) => (isChangeLine(line) ? index : -1))
    .filter((index) => index >= 0);
  const keep = new Set<number>();

  if (changes.length === 0) {
    for (let index = 0; index < Math.min(MAX_CONTEXT_LINES, hunk.lines.length); index += 1) {
      keep.add(index);
    }
  } else {
    for (const change of changes) {
      const start = Math.max(0, change - MAX_CONTEXT_LINES);
      const end = Math.min(hunk.lines.length - 1, change + MAX_CONTEXT_LINES);
      for (let index = start; index <= end; index += 1) {
        keep.add(index);
      }
    }
  }

  hunk.lines.forEach((line, index) => {
    if (line.startsWith("\\") || (!line.startsWith(" ") && !isChangeLine(line))) {
      keep.add(index);
    }
  });

  return {
    header: hunk.header,
    lines: hunk.lines.filter((_line, index) => keep.has(index)),
  };
}

function countChanges(files: DiffFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions += 1;
        if (line.startsWith("-")) deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

function renderDiff(parsed: ParsedDiff, files: DiffFile[], summary: string): string {
  return [
    ...parsed.prelude,
    ...files.flatMap((file) => [
      ...file.header,
      ...file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines]),
    ]),
    summary,
  ].join("\n");
}

export function compressDiff(input: CompressorInput): CompressorResult {
  const lines = input.content.split(/\r?\n/);
  if (lines.length < MIN_LINES_FOR_COMPRESSION) {
    return {
      changed: false,
      output: input.content,
      strategy: "diff",
      reason: "too_few_lines",
    };
  }

  const parsed = parseDiff(lines);
  if (!parsed) {
    return {
      changed: false,
      output: input.content,
      strategy: "diff",
      reason: "invalid_diff",
    };
  }

  const changes = countChanges(parsed.files);
  const files = parsed.files.map((file) => ({
    header: file.header,
    hunks: file.hunks.map(trimHunkContext),
  }));
  const originalHunkLines = parsed.files.reduce(
    (sum, file) => sum + file.hunks.reduce((inner, hunk) => inner + hunk.lines.length, 0),
    0,
  );
  const keptHunkLines = files.reduce(
    (sum, file) => sum + file.hunks.reduce((inner, hunk) => inner + hunk.lines.length, 0),
    0,
  );
  const contextLines = Math.max(0, originalHunkLines - keptHunkLines);
  const candidate = renderDiff(
    parsed,
    files,
    `[${files.length} files changed, +${changes.additions} -${changes.deletions} lines]`,
  );
  const candidateLines = candidate.split("\n").length;

  if (
    candidateLines >= lines.length * MAX_COMPRESSION_RATIO ||
    candidate.length >= input.content.length
  ) {
    return {
      changed: false,
      output: input.content,
      strategy: "diff",
      reason: "insufficient_savings",
    };
  }

  const output = `${candidate}\n${formatRetrieveMarker(input.hash)}`;
  return {
    changed: true,
    output,
    strategy: "diff",
    debug: {
      compressor: {
        strategy: "diff",
        originalChars: input.content.length,
        compressedChars: output.length,
        kept: {
          files: files.length,
          hunks: files.reduce((sum, file) => sum + file.hunks.length, 0),
          contextLines: keptHunkLines - changes.additions - changes.deletions,
        },
        dropped: { contextLines, files: 0, hunks: 0 },
      },
    },
  };
}
