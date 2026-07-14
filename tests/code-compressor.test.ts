import { describe, expect, it } from "vitest";

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

describe("code-aware compressor", () => {
  it("preserves imports, types, signatures, errors, and relevant symbols", () => {
    const original = sourceFixture();
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
      "export async function rotateCredential(tenantId: TenantId): Promise<RotationResult> {",
    );
    expect(result.output).toContain(
      'throw new AuthRotationError("credential rotation failed");',
    );
    expect(result.output).toContain(
      "function routineHelper50(value: number): number {",
    );
    expect(result.output).not.toContain("const adjusted = value + 50;");
    expect(result.output).toContain("[Retrieve more: hash=");
  });

  it("routes detected source code through the code strategy", () => {
    const original = sourceFixture();
    const result = compressByContentType({
      content: original,
      hash,
      query: "rotateCredential TenantId AuthRotationError",
    });

    expect(detectContentType(original).kind).toBe("code");
    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("code");
  });

  it("leaves short or ambiguous snippets unchanged", () => {
    const original = "const value = input + 1;\nreturn value;";
    expect(compressCode({ content: original, hash, query: "" })).toMatchObject({
      changed: false,
      output: original,
    });
  });
});
