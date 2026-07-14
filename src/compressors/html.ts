import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

function decodeEntities(content: string): string {
  return content
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function plainText(content: string): string {
  return decodeEntities(content.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function compressHtml(input: CompressorInput): CompressorResult {
  if (input.content.length < 500 || !/<[a-z][\s\S]*>/i.test(input.content)) {
    return {
      changed: false,
      output: input.content,
      strategy: "html",
      reason: "too_few_lines",
    };
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(input.content);
  const title = plainText(titleMatch?.[1] ?? "");
  let cleaned = input.content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg|noscript|nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(cleaned);
  cleaned = main?.[2] ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned)?.[1] ?? cleaned;
  cleaned = cleaned.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => `[${plainText(label)}](${href})`,
  );
  cleaned = cleaned
    .replace(/<\/?(?:table|thead|tbody)\b[^>]*>/gi, "\n")
    .replace(/<\/?tr\b[^>]*>/gi, "\n")
    .replace(/<(?:th|td)\b[^>]*>/gi, "")
    .replace(/<\/(?:th|td)>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:h[1-6]|p|li|ul|ol|section|div|pre|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const bodyLines = decodeEntities(cleaned)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").replace(/^\s*\|\s*|\s*\|\s*$/g, "").trim())
    .filter(Boolean);
  const output = [
    ...(title ? [title] : []),
    ...bodyLines,
    formatRetrieveMarker(input.hash),
  ].join("\n");
  if (!bodyLines.length || output.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "html",
      reason: bodyLines.length ? "no_savings" : "nothing_dropped",
    };
  }
  return {
    changed: true,
    output,
    strategy: "html",
    debug: {
      compressor: {
        strategy: "html",
        originalChars: input.content.length,
        compressedChars: output.length,
        kept: { title: Boolean(title), lines: bodyLines.length },
        dropped: { markupAndNoiseChars: input.content.length - output.length },
      },
    },
  };
}
