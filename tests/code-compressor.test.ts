import { describe, expect, it } from "vitest";
import { parser as javascriptParser } from "@lezer/javascript";
import { parser as pythonParser } from "@lezer/python";

import { compressCode } from "../src/compressors/code.js";
import { compressByContentType, detectContentType } from "../src/engine/router.js";

const hash = "0123456789abcdef01234567";

function sourceFixture(): string {
  return [
    'import { audit } from "./audit.js";',
    'import { AuthRotationError } from "./errors.js";',
    "export type TenantId = string & { readonly tenant: unique symbol };",
    "export interface RotationResult { rotatedAt: string; keyId: string }",
    "export async function rotateCredential(tenantId: TenantId): Promise<RotationResult> {",
    '  audit.info("rotation requested", { tenantId });',
    '  throw new AuthRotationError("credential rotation failed");',
    "}",
    ...Array.from({ length: 90 }, (_, index) => [
      `function routineHelper${index}(value: number): number {`,
      `  const adjusted = value + ${index};`,
      "  return adjusted;",
      "}",
    ].join("\n")),
  ].join("\n");
}

function syntaxErrors(content: string, language: "typescript" | "python" = "typescript"): number {
  const tree = language === "python"
    ? pythonParser.parse(content)
    : javascriptParser.configure({ dialect: "ts jsx" }).parse(content);
  const cursor = tree.cursor();
  let errors = 0;
  do {
    if (cursor.type.isError) errors += 1;
  } while (cursor.next());
  return errors;
}

function longPythonFixture(): string {
  const routineFunctions = Array.from({ length: 12 }, (_, index) => [
    "@cache_result",
    `def routine_helper_${index}(`,
    "    value: int,",
    "    multiplier: int,",
    ") -> int:",
    '    """Compute a routine value. Additional details are not required."""',
    `    stage_0 = value + ${index}`,
    "    stage_1 = stage_0 * multiplier",
    "    stage_2 = stage_1 + 2",
    "    stage_3 = stage_2 + 3",
    "    stage_4 = stage_3 + 4",
    "    stage_5 = stage_4 + 5",
    "    stage_6 = stage_5 + 6",
    "    return stage_6",
  ].join("\n"));
  return [
    "from typing import NewType",
    "TenantId = NewType('TenantId', str)",
    "",
    "async def rotate_credential(",
    "    tenant_id: TenantId,",
    ") -> RotationResult:",
    '    """Rotate credentials safely."""',
    "    current = await load_credential(tenant_id)",
    "    checked = await validate_credential(current)",
    "    rotated = await perform_rotation(checked)",
    "    persisted = await persist_credential(rotated)",
    "    if not persisted:",
    "        raise AuthRotationError('credential rotation failed')",
    "    return persisted",
    "",
    ...routineFunctions,
  ].join("\n");
}

function shortPythonFixture(): string {
  return [
    "from typing import Final",
    "",
    ...Array.from({ length: 50 }, (_, index) => [
      `def routine_${index}(value: int) -> int:`,
      `    return value + ${index}`,
      "",
    ]).flat(),
    "VERSION: Final = 1",
  ].join("\n");
}

function longTypeScriptFixture(): string {
  const routineFunctions = Array.from({ length: 12 }, (_, index) => [
    `export function routineHelper${index}<T extends number>(`,
    "  value: T,",
    "  multiplier: number,",
    "): number {",
    `  const stage0 = value + ${index};`,
    "  const stage1 = stage0 * multiplier;",
    "  const stage2 = stage1 + 2;",
    "  const stage3 = stage2 + 3;",
    "  const stage4 = stage3 + 4;",
    "  const stage5 = stage4 + 5;",
    "  const stage6 = stage5 + 6;",
    "  return stage6;",
    "}",
  ].join("\n"));
  return [
    'import { audit } from "./audit.js";',
    "export type TenantId = string & { readonly tenant: unique symbol };",
    "export interface RotationResult { rotatedAt: string; keyId: string }",
    "export async function rotateCredential(",
    "  tenantId: TenantId,",
    "): Promise<RotationResult> {",
    '  audit.info("rotation requested", { tenantId });',
    "  const current = await loadCredential(tenantId);",
    "  const checked = await validateCredential(current);",
    "  const rotated = await performRotation(checked);",
    "  const persisted = await persistCredential(rotated);",
    "  if (!persisted) {",
    '    throw new AuthRotationError("credential rotation failed");',
    "  }",
    "  return persisted;",
    "}",
    ...routineFunctions,
  ].join("\n");
}

function longJavaScriptFixture(): string {
  return [
    'import { normalize } from "./normalize.js";',
    "export const calculateReport = (value) => {",
    "  const stage0 = normalize(value);",
    "  const stage1 = stage0 + 1;",
    "  const stage2 = stage1 + 2;",
    "  const stage3 = stage2 + 3;",
    "  const stage4 = stage3 + 4;",
    "  const stage5 = stage4 + 5;",
    "  const stage6 = stage5 + 6;",
    "  return stage6;",
    "};",
    ...Array.from({ length: 10 }, (_, index) => [
      `export function routine${index}(value) {`,
      `  const step0 = value + ${index};`,
      "  const step1 = step0 + 1;",
      "  const step2 = step1 + 2;",
      "  const step3 = step2 + 3;",
      "  const step4 = step3 + 4;",
      "  const step5 = step4 + 5;",
      "  return step5;",
      "}",
    ].join("\n")),
  ].join("\n");
}

describe("code-aware compressor", () => {
  it("preserves imports, multiline types, signatures, errors, and relevant functions", () => {
    const original = longTypeScriptFixture();
    const result = compressCode({
      content: original,
      hash,
      query: "rotateCredential TenantId AuthRotationError",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain('import { audit } from "./audit.js";');
    expect(result.output).toContain(
      "export type TenantId = string & { readonly tenant: unique symbol };",
    );
    expect(result.output).toContain(
      "export async function rotateCredential(\n  tenantId: TenantId,\n): Promise<RotationResult> {",
    );
    expect(result.output).toContain(
      'throw new AuthRotationError("credential rotation failed");',
    );
    expect(result.output).toContain(
      "export function routineHelper5<T extends number>(\n  value: T,\n  multiplier: number,\n): number {",
    );
    expect(result.output).not.toContain("const stage5 = stage4 + 5;");
    expect(result.output).toContain('audit.info("rotation requested"');
    expect(result.output).toContain("// [Retrieve more: hash=");
    expect(syntaxErrors(result.output)).toBe(0);
  });

  it("compresses JavaScript arrow and function bodies into valid syntax", () => {
    const original = longJavaScriptFixture();
    const result = compressCode({ content: original, hash, query: "" });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("export const calculateReport = (value) => {");
    expect(result.output).not.toContain("const stage5 = stage4 + 5;");
    expect(syntaxErrors(result.output)).toBe(0);
  });

  it("routes detected TypeScript through the code strategy", () => {
    const original = longTypeScriptFixture();
    const result = compressByContentType({
      content: original,
      hash,
      query: "rotateCredential TenantId AuthRotationError",
    });

    expect(detectContentType(original).kind).toBe("code");
    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("code");
  });

  it("keeps short function bodies byte-exact like the Headroom baseline", () => {
    const original = sourceFixture();
    expect(
      compressCode({
        content: original,
        hash,
        query: "rotateCredential TenantId AuthRotationError",
      }),
    ).toMatchObject({ changed: false, output: original });
  });

  it("returns malformed TypeScript unchanged instead of serving a broken skeleton", () => {
    const original = [
      "export function broken( {",
      ...Array.from({ length: 40 }, () => "  value += 1;"),
      "}",
    ].join("\n");

    expect(compressCode({ content: original, hash, query: "" })).toMatchObject({
      changed: false,
      output: original,
      reason: "invalid_syntax",
    });
  });

  it("compresses Python functions while preserving decorators, signatures, docstrings, and raises", () => {
    const original = longPythonFixture();
    const result = compressCode({
      content: original,
      hash,
      query: "rotate credential TenantId AuthRotationError",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain(
      "async def rotate_credential(\n    tenant_id: TenantId,\n) -> RotationResult:",
    );
    expect(result.output).toContain("raise AuthRotationError");
    expect(result.output).toContain(
      "@cache_result\ndef routine_helper_5(\n    value: int,\n    multiplier: int,\n) -> int:",
    );
    expect(result.output).toContain('    "Compute a routine value. Additional details are not required."');
    expect(result.output).toContain("    pass  # … 9 lines omitted …");
    expect(result.output).not.toContain("stage_5 = stage_4 + 5");
    expect(result.output).toContain("# [Retrieve more: hash=");
    expect(syntaxErrors(result.output, "python")).toBe(0);
  });

  it("routes detected Python through the code strategy", () => {
    const original = longPythonFixture();
    const result = compressByContentType({
      content: original,
      hash,
      query: "rotate credential TenantId AuthRotationError",
    });

    expect(detectContentType(original).kind).toBe("code");
    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("code");
  });

  it("keeps short Python function bodies byte-exact", () => {
    const original = shortPythonFixture();
    expect(compressCode({ content: original, hash, query: "" })).toMatchObject({
      changed: false,
      output: original,
    });
  });

  it("returns malformed Python unchanged", () => {
    const original = [
      "def broken(value: int) -> int:",
      "return value",
      ...Array.from({ length: 40 }, () => "    value += 1"),
    ].join("\n");

    expect(compressCode({ content: original, hash, query: "" })).toMatchObject({
      changed: false,
      output: original,
      reason: "invalid_syntax",
    });
  });

  it("leaves short or ambiguous snippets unchanged", () => {
    const original = "const value = input + 1;\nreturn value;";
    expect(compressCode({ content: original, hash, query: "" })).toMatchObject({
      changed: false,
      output: original,
    });
  });
});
