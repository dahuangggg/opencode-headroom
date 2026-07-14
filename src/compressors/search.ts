import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

export interface SearchMatch {
  file: string;
  lineNumber: number;
  content: string;
}

const MATCH_RE = /^(?<file>.+?)(?<sep>[:\-])(?<line>\d+)\k<sep>(?<content>.*)$/;
const SEVERITY_RE =
  /\b(error|fail|failed|fatal|critical|exception|warn|warning|todo|fixme|hack|secret|password|security)\b/i;

export function parseSearchResults(content: string): SearchMatch[] {
  const results: SearchMatch[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = MATCH_RE.exec(line);
    const file = match?.groups?.file;
    const lineNumber = match?.groups?.line;
    const matchContent = match?.groups?.content;
    if (!file || !lineNumber || matchContent === undefined) {
      continue;
    }
    results.push({
      file,
      lineNumber: Number(lineNumber),
      content: matchContent,
    });
  }
  return results;
}

function scoreMatch(match: SearchMatch, query: string): number {
  let score = 0;
  if (SEVERITY_RE.test(match.content)) {
    score += 1;
  }
  const lower = match.content.toLowerCase();
  for (const word of query
    .toLowerCase()
    .split(/\W+/)
    .filter((part) => part.length > 2)) {
    if (lower.includes(word)) {
      score += 0.3;
    }
  }
  return score;
}

function severityScore(match: SearchMatch): number {
  return SEVERITY_RE.test(match.content) ? 1 : 0;
}

function queryHitCount(match: SearchMatch, query: string): number {
  const lower = match.content.toLowerCase();
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter((part) => part.length > 2)
    .filter((word) => lower.includes(word)).length;
}

export function compressSearch(input: CompressorInput): CompressorResult {
  const maxFiles = input.profile?.search.maxFiles ?? 15;
  const matchesPerFile = input.profile?.search.matchesPerFile ?? 5;
  const maxMatches = input.profile?.search.maxMatches ?? 30;
  const matches = parseSearchResults(input.content);
  if (matches.length < 20) {
    return {
      changed: false,
      output: input.content,
      strategy: "search",
      reason: "too_few_matches",
    };
  }

  const byFile = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const list = byFile.get(match.file) ?? [];
    list.push(match);
    byFile.set(match.file, list);
  }

  const required = new Map<string, SearchMatch>();
  for (const match of matches) {
    const queryHits = queryHitCount(match, input.query);
    if (severityScore(match) > 0 || queryHits >= 2) {
      required.set(`${match.file}:${match.lineNumber}`, match);
    }
  }

  const filler: SearchMatch[] = [];
  const insertionOrder = new Map(
    [...byFile.keys()].map((file, index) => [file, index]),
  );
  const fileScores = new Map(
    [...byFile.entries()].map(([file, matches]) => [
      file,
      matches.reduce(
        (score, match) => Math.max(score, scoreMatch(match, input.query)),
        0,
      ),
    ]),
  );
  const rankedFiles = [...byFile.entries()].sort((left, right) => {
    return (
      (fileScores.get(right[0]) ?? 0) - (fileScores.get(left[0]) ?? 0) ||
      (insertionOrder.get(left[0]) ?? 0) -
        (insertionOrder.get(right[0]) ?? 0)
    );
  });
  const fileRank = new Map(
    rankedFiles.map(([file], index) => [file, index]),
  );
  for (const [, fileMatches] of rankedFiles.slice(0, maxFiles)) {
    const requiredForFile = new Map<number, SearchMatch>();
    const fillerForFile = new Map<number, SearchMatch>();
    for (const match of fileMatches) {
      if (required.has(`${match.file}:${match.lineNumber}`)) {
        requiredForFile.set(match.lineNumber, match);
      }
    }
    const first = fileMatches[0];
    const last = fileMatches.at(-1);
    if (first) {
      fillerForFile.set(first.lineNumber, first);
    }
    if (last) {
      fillerForFile.set(last.lineNumber, last);
    }
    const scored = [...fileMatches].sort(
      (a, b) => scoreMatch(b, input.query) - scoreMatch(a, input.query),
    );
    for (const match of scored) {
      if (requiredForFile.size + fillerForFile.size >= matchesPerFile) {
        break;
      }
      if (!requiredForFile.has(match.lineNumber)) {
        fillerForFile.set(match.lineNumber, match);
      }
    }
    const kept = [
      ...requiredForFile.values(),
      ...fillerForFile.values(),
    ].sort(
      (a, b) => a.lineNumber - b.lineNumber,
    );
    filler.push(
      ...kept.filter(
        (match) => !required.has(`${match.file}:${match.lineNumber}`),
      ),
    );
  }

  const selected = [...required.values()];
  const selectedKeys = new Set(
    selected.map((match) => `${match.file}:${match.lineNumber}`),
  );
  filler.sort(
    (a, b) =>
      scoreMatch(b, input.query) - scoreMatch(a, input.query) ||
      (fileRank.get(a.file) ?? Number.MAX_SAFE_INTEGER) -
        (fileRank.get(b.file) ?? Number.MAX_SAFE_INTEGER) ||
      a.lineNumber - b.lineNumber,
  );
  for (const match of filler) {
    if (selected.length >= maxMatches) {
      break;
    }
    const key = `${match.file}:${match.lineNumber}`;
    if (!selectedKeys.has(key)) {
      selected.push(match);
      selectedKeys.add(key);
    }
  }

  selected.sort(
    (a, b) => a.file.localeCompare(b.file) || a.lineNumber - b.lineNumber,
  );
  const selectedByFile = new Map<string, number>();
  for (const match of selected) {
    selectedByFile.set(match.file, (selectedByFile.get(match.file) ?? 0) + 1);
  }
  const summaries: string[] = [];
  for (const [file, fileMatches] of byFile) {
    const omitted = fileMatches.length - (selectedByFile.get(file) ?? 0);
    if (omitted > 0) {
      summaries.push(`${omitted}@${file}`);
    }
  }
  const selections = selected.slice(0, 50).map((match) => {
    const key = `${match.file}:${match.lineNumber}`;
    return {
      file: match.file,
      line: match.lineNumber,
      reason: required.has(key) ? "required" : "filler",
    };
  });
  const output = [
    ...selected
      .map((match) => `${match.file}:${match.lineNumber}:${match.content}`),
    ...(summaries.length ? [`[omitted: ${summaries.join("; ")}]`] : []),
    formatRetrieveMarker(input.hash),
  ].join("\n");

  if (output.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "search",
      reason: "no_savings",
      debug: {
        compressor: {
          strategy: "search",
          originalChars: input.content.length,
          compressedChars: output.length,
          kept: {
            matches: selected.length,
            requiredMatches: required.size,
            fillerMatches: Math.max(0, selected.length - required.size),
            files: new Set(selected.map((match) => match.file)).size,
          },
          dropped: {
            matches: Math.max(0, matches.length - selected.length),
            summaries: summaries.length,
          },
          selections,
        },
      },
    };
  }
  return {
    changed: true,
    output,
    strategy: "search",
    debug: {
      compressor: {
        strategy: "search",
        originalChars: input.content.length,
        compressedChars: output.length,
        kept: {
          matches: selected.length,
          requiredMatches: required.size,
          fillerMatches: Math.max(0, selected.length - required.size),
          files: new Set(selected.map((match) => match.file)).size,
        },
        dropped: {
          matches: Math.max(0, matches.length - selected.length),
          summaries: summaries.length,
        },
        selections,
      },
    },
  };
}
