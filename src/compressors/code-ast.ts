import { parser as javascriptParser } from "@lezer/javascript";
import { parser as pythonParser } from "@lezer/python";
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
const PYTHON_PARSER = pythonParser;
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
const PYTHON_SIGNAL_RE =
  /^\s*(?:async\s+)?def\b|^\s*class\s+[A-Za-z_]\w*[^\n]*:\s*(?:#.*)?$|^\s*from\s+\S+\s+import\b/m;

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

function indentationAt(content: string, position: number): string {
  const lineStart = content.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  return /^[ \t]*/.exec(content.slice(lineStart, position))?.[0] ?? "";
}

function pythonDocstringFirstLine(
  content: string,
  body: SyntaxNode,
): string | undefined {
  const statement = body.getChild("ExpressionStatement");
  const stringNode = statement?.getChild("String");
  if (!statement || !stringNode) {
    return undefined;
  }
  const before = content.slice(body.from + 1, statement.from);
  if (before.trim()) {
    return undefined;
  }
  const literal = content.slice(stringNode.from, stringNode.to);
  const match = /^(?:[rubf]*)('''|"""|'|")([\s\S]*)\1$/i.exec(literal);
  const firstLine = match?.[2]
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? JSON.stringify(firstLine) : undefined;
}

function pythonBodyReplacement(
  content: string,
  node: SyntaxNode,
  body: SyntaxNode,
  omittedLines: number,
): string {
  const bodyText = content.slice(body.from, body.to);
  const detectedIndent = /\r?\n([ \t]+)\S/.exec(bodyText)?.[1];
  const indent = detectedIndent ?? `${indentationAt(content, node.from)}    `;
  const docstring = pythonDocstringFirstLine(content, body);
  return [
    ":",
    ...(docstring ? [`${indent}${docstring}`] : []),
    `${indent}pass  # … ${omittedLines} lines omitted …`,
  ].join("\n");
}

function collectPythonReplacements(
  content: string,
  node: SyntaxNode,
  words: string[],
  replacements: CodeBodyReplacement[],
): void {
  if (node.name === "FunctionDefinition") {
    const body = node.getChild("Body");
    if (body) {
      if (isRequiredFunction(content, node, words)) {
        return;
      }
      const omittedLines = significantBodyLines(content, body);
      if (omittedLines > 5) {
        replacements.push({
          from: body.from,
          to: body.to,
          text: pythonBodyReplacement(content, node, body, omittedLines),
          omittedLines,
        });
        return;
      }
    }
  }

  for (let child = node.firstChild; child; child = child.nextSibling) {
    collectPythonReplacements(content, child, words, replacements);
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
  const tree =
    language === "python"
      ? PYTHON_PARSER.parse(content)
      : TYPESCRIPT_PARSER.parse(content);
  return syntaxErrorCount(tree) === 0;
}

function compressParsedTree(
  content: string,
  query: string,
  language: ParsedCodeLanguage,
  tree: Tree,
): AstCompressionResult {
  if (syntaxErrorCount(tree) > 0) {
    return {
      changed: false,
      output: content,
      language,
      reason: "invalid_syntax",
      compressedBodies: 0,
      omittedLines: 0,
    };
  }

  const replacements: CodeBodyReplacement[] = [];
  const words = queryWords(query);
  if (language === "python") {
    collectPythonReplacements(content, tree.topNode, words, replacements);
  } else {
    collectJavascriptReplacements(content, tree.topNode, words, replacements);
  }
  if (replacements.length === 0) {
    return {
      changed: false,
      output: content,
      language,
      reason: "nothing_to_compress",
      compressedBodies: 0,
      omittedLines: 0,
    };
  }

  const output = applyReplacements(content, replacements);
  if (!isValidCodeSyntax(output, language)) {
    return {
      changed: false,
      output: content,
      language,
      reason: "invalid_syntax",
      compressedBodies: 0,
      omittedLines: 0,
    };
  }
  return {
    changed: true,
    output,
    language,
    compressedBodies: replacements.length,
    omittedLines: replacements.reduce(
      (sum, replacement) => sum + replacement.omittedLines,
      0,
    ),
  };
}

export function compressCodeAst(
  content: string,
  query: string,
): AstCompressionResult {
  if (PYTHON_SIGNAL_RE.test(content)) {
    return compressParsedTree(
      content,
      query,
      "python",
      PYTHON_PARSER.parse(content),
    );
  }
  if (!JAVASCRIPT_SIGNAL_RE.test(content)) {
    return {
      changed: false,
      output: content,
      reason: "unsupported_language",
      compressedBodies: 0,
      omittedLines: 0,
    };
  }
  return compressParsedTree(
    content,
    query,
    "typescript",
    TYPESCRIPT_PARSER.parse(content),
  );
}
