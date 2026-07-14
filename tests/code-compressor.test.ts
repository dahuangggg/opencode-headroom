import { describe, expect, it } from "vitest";
import { parser as javascriptParser } from "@lezer/javascript";

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

function syntaxErrors(content: string): number {
  const tree = javascriptParser.configure({ dialect: "ts jsx" }).parse(content);
  const cursor = tree.cursor();
  let errors = 0;
  do {
    if (cursor.type.isError) errors += 1;
  } while (cursor.next());
  return errors;
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

  it("leaves short or ambiguous snippets unchanged", () => {
    const original = "const value = input + 1;\nreturn value;";
    expect(compressCode({ content: original, hash, query: "" })).toMatchObject({
      changed: false,
      output: original,
    });
  });
});
