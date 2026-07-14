import { compressCodeAst } from "../compressors/code-ast.js";
import { detectContentType } from "./router.js";

export const CONTEXT_PROTECTION_MAX_CHARS = 8_000;

export type ContextProtectionReason =
  | "protected_error_output"
  | "protected_recent_code";

export type ContextProtectionDecision =
  | { preserve: false }
  | { preserve: true; reason: ContextProtectionReason };

const ERROR_INDICATORS = [
  "error",
  "fail",
  "exception",
  "traceback",
  "fatal",
  "panic",
  "crash",
] as const;

function hasStrongErrorIndicators(output: string): boolean {
  const normalized = output.toLowerCase();
  let distinctIndicators = 0;
  for (const indicator of ERROR_INDICATORS) {
    if (normalized.includes(indicator)) {
      distinctIndicators += 1;
      if (distinctIndicators >= 2) {
        return true;
      }
    }
  }
  return false;
}

function isDetectedSupportedCode(output: string): boolean {
  if (detectContentType(output).kind !== "code") {
    return false;
  }
  const parsed = compressCodeAst(output, "");
  return parsed.language !== undefined;
}

export function decideContextProtection(
  output: string,
): ContextProtectionDecision {
  if (
    output.length <= CONTEXT_PROTECTION_MAX_CHARS &&
    hasStrongErrorIndicators(output)
  ) {
    return { preserve: true, reason: "protected_error_output" };
  }

  if (isDetectedSupportedCode(output)) {
    return { preserve: true, reason: "protected_recent_code" };
  }

  return { preserve: false };
}
