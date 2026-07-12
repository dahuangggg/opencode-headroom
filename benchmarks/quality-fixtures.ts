export const QUALITY_TARGETS = [
  { label: "10KiB", bytes: 10 * 1024 },
  { label: "100KiB", bytes: 100 * 1024 },
  { label: "250KiB", bytes: 250 * 1024 },
] as const;

export interface QualityFixture {
  name: string;
  content: string;
  query: string;
  mustKeep: string[];
  structured: boolean;
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function smallestCountAtLeast(
  targetBytes: number,
  minimumCount: number,
  render: (count: number) => string,
): string {
  let low = minimumCount;
  let high = minimumCount;
  while (byteLength(render(high)) < targetBytes) {
    low = high + 1;
    high *= 2;
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (byteLength(render(middle)) >= targetBytes) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return render(low);
}

function buildJsonArray(
  targetBytes: number,
  options: { compact?: boolean; fact: string },
): string {
  return smallestCountAtLeast(targetBytes, 80, (count) => {
    const rows = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      level: index === 41 ? "ERROR" : "INFO",
      message: index === 41 ? options.fact : `routine event ${index + 1}`,
      service: "quality-api",
      region: `zone-${index % 4}`,
    }));
    if (rows.length > 27) {
      rows[26] = {
        ...rows[26],
        shape: "declared schema variation",
      } as (typeof rows)[number];
    }
    const content = options.compact
      ? JSON.stringify(rows)
      : JSON.stringify(rows, null, 2);
    return content;
  });
}

function buildJsonObject(targetBytes: number, fact: string): string {
  return smallestCountAtLeast(targetBytes, 80, (count) => {
    const object: Record<string, unknown> = {
      build: "quality-gate",
      securityNotice: fact,
    };
    for (let index = 0; index < count; index += 1) {
      object[`field_${String(index).padStart(6, "0")}`] =
        `routine object value ${index} shard ${index % 11}`;
    }
    object.zz_tail = "object payload complete";
    return JSON.stringify(object, null, 2);
  });
}

function buildNestedJson(targetBytes: number, fact: string): string {
  return smallestCountAtLeast(targetBytes, 80, (count) =>
    JSON.stringify(
      {
        request: { id: "quality-request", region: "test" },
        items: Array.from({ length: count }, (_, index) => ({
          id: index + 1,
          status: index === 37 ? "ERROR" : "ok",
          detail: index === 37 ? fact : `nested routine item ${index + 1}`,
          partition: index % 7,
        })),
        summary: { complete: true, source: "deterministic" },
      },
      null,
      2,
    ),
  );
}

function repeatLines(
  targetBytes: number,
  lineAt: (index: number) => string,
  prefix: string[] = [],
  suffix: string[] = [],
): string {
  const lines = [...prefix];
  let index = 0;
  while (byteLength([...lines, ...suffix].join("\n")) < targetBytes) {
    lines.push(lineAt(index));
    index += 1;
  }
  return [...lines, ...suffix].join("\n");
}

function buildMalformedJson(targetBytes: number, fact: string): string {
  return repeatLines(
    targetBytes,
    (index) =>
      `Routine malformed record ${index} remained recoverable for deterministic inspection.`,
    ['{"items":[', fact],
    ['"unterminated": true'],
  );
}

function buildSearch(targetBytes: number, fact: string): string {
  const fileCount = 24;
  const lines: string[] = [];
  let round = 0;
  while (byteLength(lines.join("\n")) < targetBytes) {
    for (let file = 0; file < fileCount; file += 1) {
      const lineNumber = round * fileCount + file + 1;
      const path = `src/feature_${String(file + 1).padStart(2, "0")}/worker.ts`;
      const message =
        file === fileCount - 1 && round === 0
          ? fact
          : `routine search match batch=${round} file=${file + 1}`;
      lines.push(`${path}:${lineNumber}:${message}`);
    }
    round += 1;
  }
  return lines.join("\n");
}

function buildLog(targetBytes: number, fact: string): string {
  const prefix = [
    "================ quality build starts ================",
    "INFO deterministic build initialized",
    fact,
    "Traceback (most recent call last):",
    '  File "quality.py", line 17, in verify',
    "ValueError: quality token rejected",
  ];
  return repeatLines(
    targetBytes,
    (index) => `INFO routine build unit ${index} completed shard=${index % 9}`,
    prefix,
    ["Build failed: 1 failed, 0 skipped"],
  );
}

function buildPlainText(targetBytes: number, fact: string): string {
  return repeatLines(
    targetBytes,
    (index) =>
      `Routine documentation paragraph ${index} confirms the stable quality procedure.`,
    ["# Quality Report", fact],
    ["Action required: inspect the declared release fact before publishing."],
  );
}

function buildCjkText(targetBytes: number, fact: string): string {
  return repeatLines(
    targetBytes,
    (index) => `例行检查记录 ${index}：构建步骤稳定完成，等待下一项验证。`,
    [fact, "# 发布质量检查"],
    ["操作要求：发布之前必须复核身份验证结果。"],
  );
}

function buildLongLine(targetBytes: number, fact: string): string {
  const leading = Array.from(
    { length: 6 },
    (_, index) => `Short preface ${index + 1} confirms deterministic setup.`,
  );
  const trailing = Array.from(
    { length: 6 },
    (_, index) => `Short epilogue ${index + 1} confirms deterministic cleanup.`,
  );
  const parts = [fact];
  let index = 0;
  while (byteLength([...leading, parts.join(" "), ...trailing].join("\n")) < targetBytes) {
    parts.push(
      `Routine long-line sentence ${index} carries stable filler for boundary verification.`,
    );
    index += 1;
  }
  return [...leading, parts.join(" "), ...trailing].join("\n");
}

function wrap(tag: "output" | "tool_result", content: string, returnCode = false): string {
  return `${returnCode ? "<returncode>0</returncode>\n" : ""}<${tag}>\n${content}\n</${tag}>`;
}

function buildMixed(targetBytes: number, stdoutFact: string, stderrFact: string): string {
  const half = Math.max(4_096, Math.floor(targetBytes / 2));
  const stdout = buildPlainText(half, stdoutFact);
  const stderr = buildLog(half, stderrFact);
  return `<stdout>\n${stdout}\n</stdout>\n<stderr>\n${stderr}\n</stderr>`;
}

export function createQualityCorpus(targetBytes: number): QualityFixture[] {
  const jsonArrayFact = "ERROR json array auth refresh rejected";
  const jsonObjectFact = "SECURITY object token rotation required";
  const nestedFact = "ERROR nested payment authorization rejected";
  const envelopeFact = "ERROR envelope session validation failed";
  const compactFact = "ERROR compact json credential rejected";
  const malformedFact = "Security warning: malformed payload recovery is required.";
  const searchFact = "ERROR tail auth token rejected in priority file";
  const logFact = "ERROR critical build authorization failure";
  const textFact = "Security warning: release token rotation is required.";
  const cjkFact = "安全警告：身份验证令牌轮换失败，必须立即处理。";
  const longLineFact = "Security warning: long-line credential validation failed.";
  const mixedStdoutFact = "Security warning: mixed stdout token rotation required.";
  const mixedStderrFact = "ERROR mixed stderr authorization failed";
  const wrappedSearchFact = "ERROR wrapped search credential rejected in tail file";

  return [
    {
      name: "json-array",
      content: buildJsonArray(targetBytes, { fact: jsonArrayFact }),
      query: "auth refresh declared schema variation",
      mustKeep: [jsonArrayFact, "declared schema variation"],
      structured: true,
    },
    {
      name: "json-object",
      content: buildJsonObject(targetBytes, jsonObjectFact),
      query: "token rotation payload complete",
      mustKeep: [jsonObjectFact, "object payload complete"],
      structured: true,
    },
    {
      name: "json-nested",
      content: buildNestedJson(targetBytes, nestedFact),
      query: "payment authorization rejected",
      mustKeep: [nestedFact],
      structured: true,
    },
    {
      name: "json-envelope",
      content: wrap("output", buildNestedJson(targetBytes, envelopeFact), true),
      query: "envelope session validation returncode",
      mustKeep: [envelopeFact, "<returncode>0</returncode>"],
      structured: true,
    },
    {
      name: "json-compact",
      content: buildJsonArray(targetBytes, { compact: true, fact: compactFact }),
      query: "compact credential declared schema variation",
      mustKeep: [compactFact, "declared schema variation"],
      structured: true,
    },
    {
      name: "json-malformed",
      content: buildMalformedJson(targetBytes, malformedFact),
      query: "payload recovery required",
      mustKeep: [malformedFact],
      structured: false,
    },
    {
      name: "search-tail",
      content: buildSearch(targetBytes, searchFact),
      query: "tail auth token rejected priority",
      mustKeep: [searchFact],
      structured: true,
    },
    {
      name: "build-log",
      content: buildLog(targetBytes, logFact),
      query: "critical authorization rejected",
      mustKeep: [logFact, "ValueError: quality token rejected"],
      structured: true,
    },
    {
      name: "plain-text",
      content: buildPlainText(targetBytes, textFact),
      query: "release token rotation publishing",
      mustKeep: [textFact, "Action required: inspect the declared release fact before publishing."],
      structured: false,
    },
    {
      name: "cjk-text",
      content: buildCjkText(targetBytes, cjkFact),
      query: "身份验证 令牌 轮换",
      mustKeep: [cjkFact, "操作要求：发布之前必须复核身份验证结果。"],
      structured: false,
    },
    {
      name: "long-line",
      content: buildLongLine(targetBytes, longLineFact),
      query: "credential validation failed",
      mustKeep: [longLineFact],
      structured: false,
    },
    {
      name: "mixed-sections",
      content: buildMixed(targetBytes, mixedStdoutFact, mixedStderrFact),
      query: "mixed token rotation authorization",
      mustKeep: [mixedStdoutFact, mixedStderrFact],
      structured: true,
    },
    {
      name: "wrapped-search",
      content: wrap("tool_result", buildSearch(targetBytes, wrappedSearchFact)),
      query: "credential rejected tail tool_result",
      mustKeep: [wrappedSearchFact, "<tool_result>"],
      structured: true,
    },
  ];
}

export function createExactCodeFixture(targetBytes: number): string {
  const declarations: string[] = [];
  let index = 0;
  while (byteLength(declarations.join("\n\n")) < targetBytes) {
    declarations.push(
      [
        `export function exactValue${index}(input: number): number {`,
        `  const stableValue = input + ${index};`,
        "  return stableValue;",
        "}",
      ].join("\n"),
    );
    index += 1;
  }
  return declarations.join("\n\n");
}

export function createExactDiffFixture(targetBytes: number): string {
  const blocks: string[] = [];
  let index = 0;
  while (byteLength(blocks.join("\n")) < targetBytes) {
    blocks.push(
      [
        `diff --git a/src/value_${index}.ts b/src/value_${index}.ts`,
        `--- a/src/value_${index}.ts`,
        `+++ b/src/value_${index}.ts`,
        "@@ -1,2 +1,2 @@",
        `-export const value${index} = ${index};`,
        `+export const value${index} = ${index + 1};`,
      ].join("\n"),
    );
    index += 1;
  }
  return blocks.join("\n");
}
