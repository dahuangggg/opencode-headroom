import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

const TARGET_RATIO = 0.5;
const MIN_SEGMENTS_FOR_CRUSH = 6;
const MIN_SEGMENT_CHARS = 12;
const NEAR_DUP_THRESHOLD = 0.85;
const KEYWORDS = new Set([
  "error",
  "exception",
  "failed",
  "failure",
  "fail",
  "warning",
  "traceback",
  "assert",
  "todo",
  "fixme",
  "auth",
  "secret",
  "password",
  "security",
]);

export interface TextSegmentScoreInput {
  index: number;
  total: number;
  queryWords: string[];
}

export function splitTextSegments(content: string): string[] {
  const segments: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let current = "";
    let previousTerminator = false;
    for (const char of trimmed) {
      if (previousTerminator && /\s/.test(char)) {
        const segment = current.trim();
        if (segment) {
          segments.push(segment);
        }
        current = "";
        previousTerminator = false;
        continue;
      }
      current += char;
      previousTerminator = char === "." || char === "!" || char === "?";
    }
    const segment = current.trim();
    if (segment) {
      segments.push(segment);
    }
  }
  return segments;
}

function tokenize(content: string): string[] {
  return content
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function shingles(words: string[], size: number): Set<string> {
  const result = new Set<string>();
  if (words.length === 0) {
    return result;
  }
  if (words.length < size) {
    for (let width = 1; width <= words.length; width += 1) {
      for (let index = 0; index <= words.length - width; index += 1) {
        result.add(words.slice(index, index + width).join("\u0001"));
      }
    }
    return result;
  }
  for (let index = 0; index <= words.length - size; index += 1) {
    result.add(words.slice(index, index + size).join("\u0001"));
  }
  return result;
}

function isSalient(word: string): boolean {
  if (/\d/.test(word)) {
    return true;
  }
  const normalized = word.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "");
  const lower = normalized.toLowerCase();
  if (KEYWORDS.has(lower)) {
    return true;
  }
  const letters = [...word].filter((char) => /\p{L}/u.test(char));
  if (letters.length >= 2 && letters.every((char) => char === char.toUpperCase())) {
    return true;
  }
  const dot = word.indexOf(".");
  if (dot > 0 && dot < word.length - 1) {
    return /^[A-Za-z_]/.test(word.slice(0, dot)) && /^[A-Za-z_]/.test(word.slice(dot + 1));
  }
  return false;
}

function queryRelevance(segment: string, queryWords: string[]): number {
  if (queryWords.length === 0) {
    return 0;
  }
  const segmentWords = new Set(tokenize(segment));
  const hits = queryWords.filter((word) => segmentWords.has(word)).length;
  return hits / queryWords.length;
}

export function scoreTextSegment(
  segment: string,
  input: TextSegmentScoreInput,
): number {
  const words = segment.split(/\s+/).filter(Boolean);
  const recency = (input.index + 1) / Math.max(1, input.total);
  const relevance = queryRelevance(segment, input.queryWords);
  const salience =
    words.filter((word) => isSalient(word)).length / (words.length + 1);
  const headingBoost = /^#{1,6}\s+/.test(segment) ? 1.25 : 0;
  let score = recency + relevance * 2 + salience * 1.5 + headingBoost;
  if (segment.length < MIN_SEGMENT_CHARS && headingBoost === 0) {
    score *= 0.25;
  }
  return score;
}

function isPrioritySegment(segment: string, queryWords: string[]): boolean {
  if (/^#{1,6}\s+/.test(segment)) {
    return true;
  }
  if (tokenize(segment).some((word) => KEYWORDS.has(word))) {
    return true;
  }
  return queryRelevance(segment, queryWords) > 0;
}

function addSegment(
  index: number,
  selected: Set<number>,
  seenShingles: Set<string>,
  segmentTokens: string[][],
): boolean {
  if (selected.has(index)) {
    return false;
  }
  const currentShingles = shingles(segmentTokens[index] ?? [], 3);
  if (currentShingles.size > 0) {
    const covered =
      [...currentShingles].filter((shingle) => seenShingles.has(shingle)).length /
      currentShingles.size;
    if (covered >= NEAR_DUP_THRESHOLD) {
      return false;
    }
  }
  selected.add(index);
  for (const shingle of currentShingles) {
    seenShingles.add(shingle);
  }
  return true;
}

export function compressText(input: CompressorInput): CompressorResult {
  const segments = splitTextSegments(input.content);
  if (segments.length < MIN_SEGMENTS_FOR_CRUSH) {
    return {
      changed: false,
      output: input.content,
      strategy: "text",
      reason: "too_few_segments",
    };
  }

  const queryWords = tokenize(input.query).filter((word) => word.length > 2);
  const segmentTokens = segments.map((segment) => tokenize(segment));
  const totalChars = segments.reduce((sum, segment) => sum + segment.length, 0);
  const targetChars = Math.max(1, Math.floor(totalChars * TARGET_RATIO));
  const selected = new Set<number>();
  const seenShingles = new Set<string>();
  let keptChars = 0;

  const forceKeep = new Set<number>([0, segments.length - 1]);
  segments.forEach((segment, index) => {
    if (isPrioritySegment(segment, queryWords)) {
      forceKeep.add(index);
    }
  });
  for (const index of [...forceKeep].sort((a, b) => a - b)) {
    if (addSegment(index, selected, seenShingles, segmentTokens)) {
      keptChars += segments[index]?.length ?? 0;
    }
  }

  const order = segments
    .map((segment, index) => ({
      index,
      score: scoreTextSegment(segment, {
        index,
        total: segments.length,
        queryWords,
      }),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  for (const candidate of order) {
    if (keptChars >= targetChars) {
      break;
    }
    if (addSegment(candidate.index, selected, seenShingles, segmentTokens)) {
      keptChars += segments[candidate.index]?.length ?? 0;
    }
  }

  const kept = [...selected]
    .sort((a, b) => a - b)
    .map((index) => segments[index])
    .filter((segment): segment is string => segment !== undefined);
  const output = [...kept, formatRetrieveMarker(input.hash)].join("\n");
  if (output.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "text",
      reason: "no_savings",
    };
  }
  return { changed: true, output, strategy: "text" };
}
