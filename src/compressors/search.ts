import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

export interface SearchMatch {
  file: string;
  lineNumber: number;
  content: string;
}

const MATCH_RE = /^(?<file>.+?)(?<sep>[:\-])(?<line>\d+)\k<sep>(?<content>.*)$/;
const PRIORITY_RE =
  /\b(error|fail|failed|fatal|critical|exception|warn|warning|todo|fixme|hack|auth|secret|password|security)\b/i;

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
  if (PRIORITY_RE.test(match.content)) {
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

export function compressSearch(input: CompressorInput): CompressorResult {
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

  const selected: SearchMatch[] = [];
  const summaries: string[] = [];
  for (const [file, fileMatches] of [...byFile.entries()].slice(0, 15)) {
    const keep = new Map<number, SearchMatch>();
    const first = fileMatches[0];
    const last = fileMatches.at(-1);
    if (first) {
      keep.set(first.lineNumber, first);
    }
    if (last) {
      keep.set(last.lineNumber, last);
    }
    const scored = [...fileMatches].sort(
      (a, b) => scoreMatch(b, input.query) - scoreMatch(a, input.query),
    );
    for (const match of scored) {
      if (keep.size >= 5) {
        break;
      }
      keep.set(match.lineNumber, match);
    }
    const kept = [...keep.values()].sort(
      (a, b) => a.lineNumber - b.lineNumber,
    );
    selected.push(...kept);
    const omitted = fileMatches.length - kept.length;
    if (omitted > 0) {
      summaries.push(`[... and ${omitted} more matches in ${file}]`);
    }
  }

  selected.sort(
    (a, b) => a.file.localeCompare(b.file) || a.lineNumber - b.lineNumber,
  );
  const output = [
    ...selected
      .slice(0, 30)
      .map((match) => `${match.file}:${match.lineNumber}:${match.content}`),
    ...summaries,
    formatRetrieveMarker(input.hash),
  ].join("\n");

  if (output.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "search",
      reason: "no_savings",
    };
  }
  return { changed: true, output, strategy: "search" };
}
