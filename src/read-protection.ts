import { detectContentType } from "./engine/router.js";

const READ_PROGRAMS = new Set(["cat", "head", "tail", "nl", "bat", "less", "more"]);
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash"]);
const SHELL_WRAPPERS = new Set([
  "rtk",
  "sudo",
  "env",
  "time",
  "nice",
  "ionice",
  "nohup",
  "stdbuf",
  "command",
  "timeout",
  "xargs",
]);
const RELEASABLE_READ_KINDS = new Set([
  "json",
  "search",
  "log",
  "diff",
  "table",
  "html",
]);
const LOCKFILE_RE =
  /(^|[\s/])(?:bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Pipfile\.lock|requirements\.txt\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|flake\.lock|Package\.resolved|gradle\.lockfile|packages\.lock\.json)(?:\s|$)/i;

function commandFromArgs(args: unknown): string {
  let value = args;
  if (typeof value === "string") {
    const raw = value;
    try {
      value = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const record = value as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  if (Array.isArray(command)) {
    return command.map(String).join(" ");
  }
  return typeof command === "string" ? command : "";
}

function stripWorkingDirectoryPrefixes(command: string): string {
  let current = command.trim();
  while (true) {
    const match = /^cd\s+[^&;|]+(?:&&|;)\s*(.*)$/s.exec(current);
    if (!match) return current;
    current = (match[1] ?? "").trim();
  }
}

function shellProgram(command: string): { program: string; rest: string[] } {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token.includes("=") && !token.startsWith("-")) {
      index += 1;
      continue;
    }
    const program = (token.split("/").pop() ?? "").toLowerCase();
    if (SHELL_WRAPPERS.has(program)) {
      index += 1;
      while (
        index < tokens.length &&
        ((tokens[index] ?? "").startsWith("-") ||
          /^\d+(?:\.\d+)?$/.test(tokens[index] ?? ""))
      ) {
        index += 1;
      }
      continue;
    }
    return { program, rest: tokens.slice(index + 1) };
  }
  return { program: "", rest: [] };
}

export function isRawFileReadCommand(command: string): boolean {
  if (!command.trim()) return false;
  const normalized = stripWorkingDirectoryPrefixes(command);
  if (/(^|\s)(?:\d*>>?|tee\b|<<)/.test(normalized)) return false;

  const { program, rest } = shellProgram(normalized);
  if (!program) return false;
  if (SHELL_PROGRAMS.has(program)) {
    const commandFlag = rest.findIndex((token) =>
      ["-c", "-lc", "-lic", "-ic"].includes(token),
    );
    if (commandFlag < 0 || commandFlag + 1 >= rest.length) return false;
    return isRawFileReadCommand(
      rest
        .slice(commandFlag + 1)
        .join(" ")
        .replace(/^['"]|['"]$/g, ""),
    );
  }

  const readsFile =
    READ_PROGRAMS.has(program) ||
    (program === "sed" && /(^|\s)-n(?:\s|$)/.test(normalized));
  return readsFile && !LOCKFILE_RE.test(normalized);
}

export function shouldPreserveRawFileRead(args: unknown, output: string): boolean {
  if (!output || !isRawFileReadCommand(commandFromArgs(args))) return false;
  try {
    return !RELEASABLE_READ_KINDS.has(detectContentType(output).kind);
  } catch {
    return true;
  }
}
