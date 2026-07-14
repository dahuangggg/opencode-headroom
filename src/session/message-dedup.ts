import {
  deduplicateSpans,
  type SpanDedupBlock,
  type SpanDedupStats,
} from "./span-dedup.js";
import type { ContextMutationWindow } from "./context-lifecycle.js";

interface CompletedToolStateLike {
  output: string;
  metadata?: unknown;
}

interface ToolOutputRef {
  part: object;
  state: CompletedToolStateLike;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasCacheControl(...values: unknown[]): boolean {
  return values.some((value) => {
    const metadata = record(value);
    return Boolean(metadata?.cache_control ?? metadata?.cacheControl);
  });
}

function completedToolOutput(part: unknown): ToolOutputRef | undefined {
  const candidate = record(part);
  if (candidate?.type !== "tool") return undefined;
  const state = record(candidate.state);
  if (state?.status !== "completed" || typeof state.output !== "string") {
    return undefined;
  }
  return {
    part: candidate,
    state: state as unknown as CompletedToolStateLike,
  };
}

export function deduplicateMessageToolOutputs(
  messages: readonly { parts: readonly unknown[] }[],
  mutation?: Pick<ContextMutationWindow, "canMutateToolPart">,
): SpanDedupStats {
  const references: ToolOutputRef[] = [];
  const blocks: SpanDedupBlock[] = [];

  messages.forEach((message, messageIndex) => {
    message.parts.forEach((part) => {
      const reference = completedToolOutput(part);
      if (!reference || !reference.state.output) return;
      const candidate = record(part);
      references.push(reference);
      blocks.push({
        text: reference.state.output,
        turn: messageIndex + 1,
        protected:
          hasCacheControl(candidate?.metadata, reference.state.metadata) ||
          (mutation !== undefined &&
            !mutation.canMutateToolPart(reference.part)),
      });
    });
  });

  const result = deduplicateSpans(blocks);
  result.blocks.forEach((block, index) => {
    const reference = references[index];
    if (reference) reference.state.output = block.text;
  });
  return result.stats;
}
