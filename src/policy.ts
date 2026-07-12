export type ToolPolicyAction = "preserve" | "compress";
export type CompressionStrength = "conservative" | "balanced" | "aggressive";
export type PolicyRetrieveMode = "summary" | "head" | "tail" | "full";

export interface ToolPolicyRule {
  id: string;
  tools: string[];
  action: ToolPolicyAction;
  strength?: CompressionStrength;
  minimum?:
    | "always"
    | {
        tokens?: number;
        chars?: number;
      };
  ccr?: {
    ttlHours?: number;
  };
  retrieve?: {
    defaultMode?: PolicyRetrieveMode;
    maxChars?: number;
  };
}

export interface ToolPolicyConfig {
  default?: {
    action?: ToolPolicyAction;
    strength?: CompressionStrength;
  };
  rules?: ToolPolicyRule[];
}

export interface NormalizedToolPolicy {
  default: {
    action: ToolPolicyAction;
    strength: CompressionStrength;
  };
  rules: NormalizedToolPolicyRule[];
}

interface NormalizedToolPolicyRule extends ToolPolicyRule {
  source: "user" | "compatibility";
  matches(toolName: string): boolean;
}

export interface ResolvedToolPolicy {
  ruleId: string;
  source: "user" | "compatibility" | "builtin" | "default";
  action: ToolPolicyAction;
  strength: CompressionStrength;
  minimum?: ToolPolicyRule["minimum"];
  ccr?: ToolPolicyRule["ccr"];
  retrieve?: ToolPolicyRule["retrieve"];
}

const BUILTIN_EXACT_CONTENT_TOOLS = ["Read", "Edit", "Write", "apply_patch"];
const NON_OVERRIDABLE_HEADROOM_TOOLS = ["headroom_*"];
const BUILTIN_CONTEXT_TOOLS = ["ctx_*"];
const ACTIONS = ["preserve", "compress"] as const;
const STRENGTHS = ["conservative", "balanced", "aggressive"] as const;
const RETRIEVE_MODES = ["summary", "head", "tail", "full"] as const;

export function compileToolPattern(pattern: string): (toolName: string) => boolean {
  if (!pattern.trim()) {
    throw new Error("Tool patterns must be non-empty strings");
  }
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const matcher = new RegExp(`^${expression}$`, "i");
  return (toolName: string) => matcher.test(toolName);
}

const NON_OVERRIDABLE_HEADROOM_MATCHERS = NON_OVERRIDABLE_HEADROOM_TOOLS.map(
  compileToolPattern,
);
const BUILTIN_CONTEXT_MATCHERS = BUILTIN_CONTEXT_TOOLS.map(
  compileToolPattern,
);
const BUILTIN_EXACT_CONTENT_MATCHERS = BUILTIN_EXACT_CONTENT_TOOLS.map(
  compileToolPattern,
);

function assertPositiveFinite(
  value: number | undefined,
  label: string,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function assertEnum(
  value: unknown,
  values: readonly string[],
  label: string,
): void {
  if (value !== undefined && !values.includes(value as string)) {
    throw new Error(`${label} must be one of: ${values.join(", ")}`);
  }
}

function normalizeRule(
  rule: ToolPolicyRule,
  source: "user" | "compatibility",
): NormalizedToolPolicyRule {
  if (typeof rule.id !== "string" || !rule.id.trim()) {
    throw new Error("Tool policy rule id must be a non-empty string");
  }
  if (!Array.isArray(rule.tools) || rule.tools.length === 0) {
    throw new Error(`Tool policy rule ${rule.id} must select at least one tool pattern`);
  }
  if (rule.tools.some((pattern) => typeof pattern !== "string" || !pattern.trim())) {
    throw new Error(`Tool policy rule ${rule.id} has an empty tool pattern`);
  }
  if (!ACTIONS.includes(rule.action)) {
    throw new Error(
      `toolPolicy.rules.${rule.id}.action must be one of: ${ACTIONS.join(", ")}`,
    );
  }
  assertEnum(rule.strength, STRENGTHS, `toolPolicy.rules.${rule.id}.strength`);

  if (rule.action === "preserve") {
    const incompatible = [
      rule.strength !== undefined ? "strength" : "",
      rule.minimum !== undefined ? "minimum" : "",
      rule.ccr !== undefined ? "ccr" : "",
      rule.retrieve !== undefined ? "retrieve" : "",
    ].filter(Boolean);
    if (incompatible.length > 0) {
      throw new Error(
        `Tool policy preserve rule ${rule.id} cannot configure ${incompatible.join(", ")}`,
      );
    }
  }

  if (rule.minimum !== undefined && rule.minimum !== "always") {
    if (
      !rule.minimum ||
      typeof rule.minimum !== "object" ||
      Array.isArray(rule.minimum)
    ) {
      throw new Error(`toolPolicy.rules.${rule.id}.minimum is invalid`);
    }
    assertPositiveFinite(rule.minimum.tokens, "Minimum tokens");
    assertPositiveFinite(rule.minimum.chars, "Minimum chars");
    if (rule.minimum.tokens === undefined && rule.minimum.chars === undefined) {
      throw new Error(`toolPolicy.rules.${rule.id}.minimum must set tokens or chars`);
    }
  }
  if (
    rule.ccr !== undefined &&
    (!rule.ccr || typeof rule.ccr !== "object" || Array.isArray(rule.ccr))
  ) {
    throw new Error(`toolPolicy.rules.${rule.id}.ccr must be an object`);
  }
  if (
    rule.retrieve !== undefined &&
    (!rule.retrieve ||
      typeof rule.retrieve !== "object" ||
      Array.isArray(rule.retrieve))
  ) {
    throw new Error(`toolPolicy.rules.${rule.id}.retrieve must be an object`);
  }
  assertPositiveFinite(rule.ccr?.ttlHours, "ttlHours");
  assertEnum(
    rule.retrieve?.defaultMode,
    RETRIEVE_MODES,
    "retrieve.defaultMode",
  );
  assertPositiveFinite(rule.retrieve?.maxChars, "retrieve.maxChars");

  const tools = [...rule.tools];
  const matchers = tools.map(compileToolPattern);
  return {
    ...rule,
    id: rule.id.trim(),
    tools,
    source,
    matches: (toolName) => matchers.some((matcher) => matcher(toolName)),
    minimum:
      rule.minimum && rule.minimum !== "always"
        ? { ...rule.minimum }
        : rule.minimum,
    ccr: rule.ccr ? { ...rule.ccr } : undefined,
    retrieve: rule.retrieve ? { ...rule.retrieve } : undefined,
  };
}

export function normalizeToolPolicy(
  input: ToolPolicyConfig | undefined,
  compatibilityTools: string[] = [],
): NormalizedToolPolicy {
  if (
    input !== undefined &&
    (!input || typeof input !== "object" || Array.isArray(input))
  ) {
    throw new Error("toolPolicy must be an object");
  }
  if (
    input?.default !== undefined &&
    (!input.default ||
      typeof input.default !== "object" ||
      Array.isArray(input.default))
  ) {
    throw new Error("toolPolicy.default must be an object");
  }
  if (input?.rules !== undefined && !Array.isArray(input.rules)) {
    throw new Error("toolPolicy.rules must be an array");
  }
  assertEnum(input?.default?.action, ACTIONS, "toolPolicy.default.action");
  assertEnum(input?.default?.strength, STRENGTHS, "toolPolicy.default.strength");
  const rules = input?.rules ?? [];
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") {
      throw new Error("toolPolicy.rules entries must be objects");
    }
    const id = typeof rule.id === "string" ? rule.id.trim() : "";
    if (ids.has(id)) {
      throw new Error(`Duplicate tool policy rule id: ${rule.id}`);
    }
    ids.add(id);
  }

  const normalizedUserRules = rules.map((rule) => normalizeRule(rule, "user"));
  const compatibilityRules = compatibilityTools.length
    ? [
        normalizeRule(
          {
            id: "legacy-skip-tools",
            tools: [...compatibilityTools],
            action: "preserve",
          },
          "compatibility",
        ),
      ]
    : [];

  return {
    default: {
      action: input?.default?.action ?? "compress",
      strength: input?.default?.strength ?? "balanced",
    },
    rules: [...normalizedUserRules, ...compatibilityRules],
  };
}

export function resolveToolPolicy(
  toolName: string,
  policy: NormalizedToolPolicy,
): ResolvedToolPolicy {
  if (NON_OVERRIDABLE_HEADROOM_MATCHERS.some((matches) => matches(toolName))) {
    return {
      ruleId: "safety-headroom-tools",
      source: "builtin",
      action: "preserve",
      strength: policy.default.strength,
    };
  }

  const rule = policy.rules.find((candidate) =>
    candidate.matches(toolName),
  );

  if (rule) {
    return {
      ruleId: rule.id,
      source: rule.source,
      action: rule.action,
      strength: rule.strength ?? policy.default.strength,
      minimum: rule.minimum,
      ccr: rule.ccr,
      retrieve: rule.retrieve,
    };
  }

  if (
    BUILTIN_CONTEXT_MATCHERS.some((matches) => matches(toolName))
  ) {
    return {
      ruleId: "builtin-context-tools",
      source: "builtin",
      action: "preserve",
      strength: policy.default.strength,
    };
  }

  if (
    BUILTIN_EXACT_CONTENT_MATCHERS.some((matches) => matches(toolName))
  ) {
    return {
      ruleId: "builtin-exact-content",
      source: "builtin",
      action: "preserve",
      strength: policy.default.strength,
    };
  }

  return {
    ruleId: "default",
    source: "default",
    action: policy.default.action,
    strength: policy.default.strength,
  };
}
