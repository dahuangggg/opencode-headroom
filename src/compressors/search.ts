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
  const filler: SearchMatch[] = [];
  const summaries: string[] = [];
  for (const [file, fileMatches] of [...byFile.entries()].slice(0, 15)) {
    const requiredForFile = new Map<number, SearchMatch>();
    const fillerForFile = new Map<number, SearchMatch>();
    for (const match of fileMatches) {
      const queryHits = queryHitCount(match, input.query);
      if (severityScore(match) > 0 || queryHits >= 2) {
        requiredForFile.set(match.lineNumber, match);
        required.set(`${match.file}:${match.lineNumber}`, match);
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
      if (requiredForFile.size + fillerForFile.size >= 5) {
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
    const omitted = fileMatches.length - kept.length;
    if (omitted > 0) {
      summaries.push(`[... and ${omitted} more matches in ${file}]`);
    }
  }

  const selected = [...required.values()];
  const selectedKeys = new Set(
    selected.map((match) => `${match.file}:${match.lineNumber}`),
  );
  filler.sort(
    (a, b) => a.file.localeCompare(b.file) || a.lineNumber - b.lineNumber,
  );
  for (const match of filler) {
    if (selected.length >= 30) {
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
  const output = [
    ...selected
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
