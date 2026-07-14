import { parser as javascriptParser } from "@lezer/javascript";
import type { SyntaxNode, Tree } from "@lezer/common";

export type ParsedCodeLanguage = "typescript" | "python";

export interface CodeBodyReplacement {
  from: number;
  to: number;
  text: string;
  omittedLines: number;
}

export interface AstCompressionResult {
  changed: boolean;
  output: string;
  language?: ParsedCodeLanguage;
  reason?: "invalid_syntax" | "unsupported_language" | "nothing_to_compress";
  compressedBodies: number;
  omittedLines: number;
}

const TYPESCRIPT_PARSER = javascriptParser.configure({ dialect: "ts jsx" });
const JAVASCRIPT_FUNCTION_NODES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunction",
  "MethodDeclaration",
  "GeneratorDeclaration",
  "GeneratorExpression",
]);
const ERROR_RE =
  /\b(?:throw|raise|panic|fatal|critical|error|exception|failed|security)\b/i;
const JAVASCRIPT_SIGNAL_RE =
  /\b(?:function|interface|namespace|enum|implements|extends)\b|=>|^\s*(?:import|export|class|type|const|let|var)\b/m;

function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$]+/u)
    .filter((word) => word.length > 2);
}

function syntaxErrorCount(tree: Tree): number {
  const cursor = tree.cursor();
  let errors = 0;
  do {
    if (cursor.type.isError) errors += 1;
  } while (cursor.next());
  return errors;
}

function significantBodyLines(content: string, body: SyntaxNode): number {
  return content
    .slice(body.from + 1, Math.max(body.from + 1, body.to - 1))
    .split(/\r?\n/)
    .filter((line) => line.trim()).length;
}

function isRequiredFunction(
  content: string,
  node: SyntaxNode,
  words: string[],
): boolean {
  const text = content.slice(node.from, node.to);
  if (ERROR_RE.test(text)) {
    return true;
  }
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}

function collectJavascriptReplacements(
  content: string,
  node: SyntaxNode,
  words: string[],
  replacements: CodeBodyReplacement[],
): void {
  if (JAVASCRIPT_FUNCTION_NODES.has(node.name)) {
    const body = node.getChild("Block");
    if (body) {
      if (isRequiredFunction(content, node, words)) {
        return;
      }
      const omittedLines = significantBodyLines(content, body);
      if (omittedLines > 5) {
        replacements.push({
          from: body.from,
          to: body.to,
          text: `{ /* … ${omittedLines} lines omitted … */ }`,
          omittedLines,
        });
        return;
      }
    }
  }

  for (let child = node.firstChild; child; child = child.nextSibling) {
    collectJavascriptReplacements(content, child, words, replacements);
  }
}

function applyReplacements(
  content: string,
  replacements: CodeBodyReplacement[],
): string {
  let output = content;
  for (const replacement of [...replacements].sort((a, b) => b.from - a.from)) {
    output =
      output.slice(0, replacement.from) +
      replacement.text +
      output.slice(replacement.to);
  }
  return output;
}

export function isValidCodeSyntax(
  content: string,
  language: ParsedCodeLanguage,
): boolean {
  if (language !== "typescript") {
    return false;
  }
  return syntaxErrorCount(TYPESCRIPT_PARSER.parse(content)) === 0;
}

export function compressCodeAst(
  content: string,
  query: string,
): AstCompressionResult {
  if (!JAVASCRIPT_SIGNAL_RE.test(content)) {
    return {
      changed: false,
      output: content,
      reason: "unsupported_language",
      compressedBodies: 0,
      omittedLines: 0,
    };
  }

  const tree = TYPESCRIPT_PARSER.parse(content);
  if (syntaxErrorCount(tree) > 0) {
    return {
      changed: false,
      output: content,
      language: "typescript",
      reason: "invalid_syntax",
      compressedBodies: 0,
      omittedLines: 0,
    };
  }

  const replacements: CodeBodyReplacement[] = [];
  collectJavascriptReplacements(
    content,
    tree.topNode,
    queryWords(query),
    replacements,
  );
  if (replacements.length === 0) {
    return {
      changed: false,
      output: content,
      language: "typescript",
      reason: "nothing_to_compress",
      compressedBodies: 0,
      omittedLines: 0,
    };
  }

  const output = applyReplacements(content, replacements);
  if (!isValidCodeSyntax(output, "typescript")) {
    return {
      changed: false,
      output: content,
      language: "typescript",
      reason: "invalid_syntax",
      compressedBodies: 0,
      omittedLines: 0,
    };
  }
  return {
    changed: true,
    output,
    language: "typescript",
    compressedBodies: replacements.length,
    omittedLines: replacements.reduce(
      (sum, replacement) => sum + replacement.omittedLines,
      0,
    ),
  };
}
