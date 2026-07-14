const INFORMATION_WEIGHT = 0.8;
const COVERAGE_WEIGHT = 0.2;

export function rankInformationItems(
  items: readonly string[],
  requiredIndexes: ReadonlySet<number>,
): number[] {
  const candidates = items
    .map((_, index) => index)
    .filter((index) => !requiredIndexes.has(index));
  if (candidates.length <= 1) {
    return candidates;
  }

  const tokenSets = items.map(informationTokens);
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenSets) {
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const maximumLength = Math.max(1, ...items.map((item) => item.length));
  const informationScores = tokenSets.map((tokens, index) => {
    const rarity = tokens.size === 0
      ? 0
      : [...tokens].reduce(
          (sum, token) =>
            sum
            + Math.log((items.length + 1) / ((documentFrequency.get(token) ?? 0) + 1))
              / Math.log(items.length + 1),
          0,
        ) / tokens.size;
    const length = (items[index]?.length ?? 0) / maximumLength;
    return rarity * 0.85 + length * 0.15;
  });

  const distributed = distributedIndexes(items.length).filter(
    (index) => !requiredIndexes.has(index),
  );
  const coverageRank = new Map(
    distributed.map((index, rank) => [index, rank]),
  );

  return candidates.sort((left, right) => {
    const leftScore = combinedScore(
      informationScores[left] ?? 0,
      coverageRank.get(left) ?? distributed.length,
      distributed.length,
    );
    const rightScore = combinedScore(
      informationScores[right] ?? 0,
      coverageRank.get(right) ?? distributed.length,
      distributed.length,
    );
    return rightScore - leftScore || left - right;
  });
}

function informationTokens(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/\p{N}+/gu, "N");
  return new Set(
    normalized
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((token) => token.length > 1),
  );
}

function combinedScore(
  informationScore: number,
  coverageRank: number,
  candidateCount: number,
): number {
  const coverageScore = candidateCount <= 1
    ? 1
    : 1 - coverageRank / (candidateCount - 1);
  return informationScore * INFORMATION_WEIGHT + coverageScore * COVERAGE_WEIGHT;
}

function distributedIndexes(length: number): number[] {
  const order: number[] = [];
  const ranges: Array<readonly [start: number, end: number]> = [[0, length - 1]];

  for (let cursor = 0; cursor < ranges.length; cursor += 1) {
    const [start, end] = ranges[cursor] ?? [0, -1];
    if (start > end) {
      continue;
    }
    const middle = Math.floor((start + end) / 2);
    order.push(middle);
    if (start <= middle - 1) {
      ranges.push([start, middle - 1]);
    }
    if (middle + 1 <= end) {
      ranges.push([middle + 1, end]);
    }
  }

  return order;
}
