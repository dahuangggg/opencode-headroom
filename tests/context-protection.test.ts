import { describe, expect, it } from "vitest";

import {
  CONTEXT_PROTECTION_MAX_CHARS,
  decideContextProtection,
} from "../src/engine/context-protection.js";

describe("tool output context protection", () => {
  it("protects short output with at least two distinct error indicators", () => {
    const output = [
      "Traceback (most recent call last):",
      '  File "/app/worker.py", line 12, in run',
      "ValueError: failed to parse payload",
    ].join("\n");

    expect(decideContextProtection(output)).toEqual({
      preserve: true,
      reason: "protected_error_output",
    });
  });

  it("counts the error protection cap in UTF-16 code units", () => {
    const indicators = "error fatal ";
    const output = `${indicators}${"😀".repeat(
      (CONTEXT_PROTECTION_MAX_CHARS - indicators.length) / 2,
    )}`;

    expect(output.length).toBe(CONTEXT_PROTECTION_MAX_CHARS);
    expect(decideContextProtection(output)).toEqual({
      preserve: true,
      reason: "protected_error_output",
    });
  });

  it("does not protect oversized error output", () => {
    const indicators = "error fatal ";
    const output = `${indicators}${"x".repeat(
      CONTEXT_PROTECTION_MAX_CHARS + 1 - indicators.length,
    )}`;

    expect(output.length).toBe(CONTEXT_PROTECTION_MAX_CHARS + 1);
    expect(decideContextProtection(output)).toEqual({ preserve: false });
  });

  it("does not misclassify a benign single error indicator", () => {
    const output = Array.from(
      { length: 40 },
      (_, index) => `src/error_handler.py:${index + 1}: error_count += 1`,
    ).join("\n");

    expect(decideContextProtection(output)).toEqual({ preserve: false });
  });

  it.each([
    [
      "python",
      [
        "def normalize(value):",
        "    if value is None:",
        "        return ''",
        "    return str(value).strip()",
      ].join("\n"),
    ],
    [
      "typescript",
      [
        "export interface User { id: string }",
        "export function normalize(user: User): string {",
        "  return user.id.trim();",
        "}",
      ].join("\n"),
    ],
    [
      "javascript",
      [
        "export function normalize(value) {",
        "  if (value == null) return '';",
        "  return String(value).trim();",
        "}",
      ].join("\n"),
    ],
  ])("protects valid recent %s source output", (_language, output) => {
    expect(decideContextProtection(output)).toEqual({
      preserve: true,
      reason: "protected_recent_code",
    });
  });

  it.each([
    [
      "malformed Python",
      [
        "def broken_one(:",
        "    return 1",
        "def broken_two(:",
        "    return 2",
        "def broken_three(:",
        "    return 3",
      ].join("\n"),
    ],
    [
      "malformed TypeScript",
      [
        "export function brokenOne( { return 1; }",
        "export function brokenTwo( { return 2; }",
        "export function brokenThree( { return 3; }",
      ].join("\n"),
    ],
  ])("protects detected %s output while it is still the active code", (_case, output) => {
    expect(decideContextProtection(output)).toEqual({
      preserve: true,
      reason: "protected_recent_code",
    });
  });

  it("does not protect unsupported Rust output", () => {
    const output = "pub fn normalize(value: &str) -> String { value.trim().into() }";

    expect(decideContextProtection(output)).toEqual({ preserve: false });
  });

  it("does not treat one malformed declaration as detected source code", () => {
    expect(decideContextProtection("def broken(:\n    return 1")).toEqual({
      preserve: false,
    });
  });
});
