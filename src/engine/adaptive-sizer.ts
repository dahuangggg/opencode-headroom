import { deflateSync } from "node:zlib";

export interface AdaptiveSizingOptions {
  bias: number;
  minK: number;
  maxK: number;
}

export interface AdaptiveSizingDecision {
  k: number;
  knee?: number;
  uniqueGroups: number;
  diversity: number;
  zlibAdjusted: boolean;
  reason: "small" | "redundant" | "knee" | "diversity";
}

type Fingerprint = readonly [low: number, high: number];

const SIMHASH_DISTANCE = 3;
const KNEE_THRESHOLD = 0.05;
const ZLIB_TOLERANCE = 0.15;

export function computeOptimalK(
  items: readonly string[],
  options: AdaptiveSizingOptions,
): AdaptiveSizingDecision {
  const maxK = Math.min(items.length, normalizeBound(options.maxK));
  const minK = Math.min(maxK, normalizeBound(options.minK));
  if (maxK === 0) {
    return decision(0, 0, 0, false, "small");
  }

  if (items.length <= 8) {
    return decision(maxK, items.length, items.length === 0 ? 0 : 1, false, "small");
  }

  const analysisLimit = Math.max(256, maxK * 4);
  const analyzedItems = items.slice(0, analysisLimit);
  const uniqueGroups = countUniqueSimhash(analyzedItems);
  const diversity = uniqueGroups / analyzedItems.length;

  if (uniqueGroups <= 3) {
    return decision(
      clamp(Math.max(minK, uniqueGroups), minK, maxK),
      uniqueGroups,
      diversity,
      false,
      "redundant",
    );
  }

  const curve = computeUniqueBigramCurve(analyzedItems);
  const knee = findKnee(curve);
  const diversityFloor = Math.max(
    minK,
    Math.trunc(analyzedItems.length * (0.3 + 0.7 * diversity)),
  );
  const baseK = knee === undefined
    ? diversityFloor
    : diversity > 0.7
      ? Math.max(knee, diversityFloor)
      : knee;
  const bias = Number.isFinite(options.bias) && options.bias > 0
    ? options.bias
    : 1;
  const biasedK = clamp(Math.trunc(baseK * bias), minK, maxK);
  const validatedK = validateWithZlib(analyzedItems, biasedK, maxK);
  const reason = knee === undefined || diversity > 0.7 ? "diversity" : "knee";

  return {
    ...decision(
      validatedK,
      uniqueGroups,
      diversity,
      validatedK !== biasedK,
      reason,
    ),
    ...(knee === undefined ? {} : { knee }),
  };
}

export function computeUniqueBigramCurve(
  items: readonly string[],
): number[] {
  const seen = new Set<string>();
  const curve: number[] = [];

  for (const item of items) {
    const normalized = item.toLocaleLowerCase();
    const words = normalized.trim().split(/\s+/u).filter(Boolean);
    const characters = [...normalized];

    if (
      words.length === 1
      && characters.length > 1
      && !/\s/u.test(normalized)
      && /\p{Script=Han}/u.test(normalized)
    ) {
      for (let index = 0; index < characters.length - 1; index += 1) {
        seen.add(`${characters[index]}\u0000${characters[index + 1]}`);
      }
    } else if (words.length < 2) {
      seen.add(`${words[0] ?? ""}\u0000`);
    } else {
      for (let index = 0; index < words.length - 1; index += 1) {
        seen.add(`${words[index]}\u0000${words[index + 1]}`);
      }
    }

    curve.push(seen.size);
  }

  return curve;
}

export function findKnee(curve: readonly number[]): number | undefined {
  if (curve.length < 3) {
    return undefined;
  }

  const first = curve[0] ?? 0;
  const last = curve[curve.length - 1] ?? first;
  if (last === first) {
    return 1;
  }

  const xRange = curve.length - 1;
  const yRange = last - first;
  let maximumDifference = -1;
  let kneeIndex = 0;

  for (let index = 0; index < curve.length; index += 1) {
    const x = index / xRange;
    const y = ((curve[index] ?? first) - first) / yRange;
    const difference = y - x;
    if (difference > maximumDifference) {
      maximumDifference = difference;
      kneeIndex = index;
    }
  }

  return maximumDifference < KNEE_THRESHOLD ? undefined : kneeIndex + 1;
}

function countUniqueSimhash(items: readonly string[]): number {
  const representatives: Fingerprint[] = [];

  for (const item of items) {
    const fingerprint = simhash(item);
    if (
      !representatives.some(
        (representative) =>
          hammingDistance(fingerprint, representative) <= SIMHASH_DISTANCE,
      )
    ) {
      representatives.push(fingerprint);
    }
  }

  return representatives.length;
}

function simhash(value: string): Fingerprint {
  const characters = [...value.toLocaleLowerCase()];
  const gramCount = Math.max(1, characters.length - 3);
  const votes = new Int32Array(64);

  for (let index = 0; index < gramCount; index += 1) {
    const gram = characters.slice(index, index + 4).join("");
    const low = hash32(gram, 0x811c9dc5);
    const high = hash32(gram, 0x9e3779b9);

    for (let bit = 0; bit < 32; bit += 1) {
      votes[bit] = (votes[bit] ?? 0) + (((low >>> bit) & 1) ? 1 : -1);
      votes[bit + 32] = (votes[bit + 32] ?? 0)
        + (((high >>> bit) & 1) ? 1 : -1);
    }
  }

  let low = 0;
  let high = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if ((votes[bit] ?? 0) > 0) {
      low |= 1 << bit;
    }
    if ((votes[bit + 32] ?? 0) > 0) {
      high |= 1 << bit;
    }
  }

  return [low >>> 0, high >>> 0];
}

function hash32(value: string, seed: number): number {
  let hash = seed | 0;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return hash >>> 0;
}

function hammingDistance(left: Fingerprint, right: Fingerprint): number {
  return popcount32(left[0] ^ right[0]) + popcount32(left[1] ^ right[1]);
}

function popcount32(value: number): number {
  let bits = value >>> 0;
  bits -= (bits >>> 1) & 0x55555555;
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function validateWithZlib(
  items: readonly string[],
  k: number,
  maxK: number,
): number {
  if (k >= items.length || k >= maxK || k === 0) {
    return k;
  }

  const fullText = items.join("\n");
  const subsetText = items.slice(0, k).join("\n");
  if (Buffer.byteLength(fullText) < 200 || subsetText.length === 0) {
    return k;
  }

  const fullRatio = deflateSync(fullText, { level: 1 }).length
    / Buffer.byteLength(fullText);
  const subsetRatio = deflateSync(subsetText, { level: 1 }).length
    / Buffer.byteLength(subsetText);

  if (Math.abs(fullRatio - subsetRatio) <= ZLIB_TOLERANCE) {
    return k;
  }

  return Math.min(maxK, Math.trunc(k * 1.2));
}

function normalizeBound(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function decision(
  k: number,
  uniqueGroups: number,
  diversity: number,
  zlibAdjusted: boolean,
  reason: AdaptiveSizingDecision["reason"],
): AdaptiveSizingDecision {
  return { k, uniqueGroups, diversity, zlibAdjusted, reason };
}
