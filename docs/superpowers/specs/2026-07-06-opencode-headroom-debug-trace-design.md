# OpenCode Headroom Debug Trace Design

Date: 2026-07-06

## Summary

Add an optional debug trace module for `opencode-headroom` so developers can inspect why a tool output was skipped or how it was compressed. Debug output must be observational only: enabling it must not change compression decisions, hashes, CCR storage, or retrieved content.

## Configuration

Debug remains off by default.

```json
{
  "debug": true,
  "debugLevel": "summary",
  "debugSink": "both",
  "debugPath": ".headroom/debug.ndjson"
}
```

- `debug`: enables debug output.
- `debugLevel`: `"summary"` stores hook and aggregate compressor decisions; `"trace"` also includes bounded kept-item selectors.
- `debugSink`: `"metadata"`, `"file"`, or `"both"`.
- `debugPath`: NDJSON file used when the sink includes `"file"`.

## Event Model

The plugin emits structured events:

- `hook`: skip/compress decision, threshold inputs, tool/session/call IDs.
- `router`: detected content kind and confidence.
- `compressor`: strategy, original/compressed sizes, kept/dropped counts, and bounded selection summaries.
- `ccr`: emitted hash and storage outcome.

Metadata receives a compact `metadata.headroom.debug` summary. File traces receive one JSON object per tool execution in NDJSON format.

## Privacy

Debug output must avoid storing full original output. Compressor traces may include structural selectors such as row indexes, file paths, line numbers, levels, and reasons. Text/log samples are omitted by default. Future sample fields must be truncated and redacted.

## Invariants

- `debug: false` keeps existing output and metadata unchanged.
- `debug: true` does not change compressed output, hash, stored original, retrieval result, or token counts.
- File trace failures are swallowed; compression must still work.
- Default skip rules still apply to `headroom_*` and `ctx_*` tools.

## Tests

Coverage should include:

- Config defaults and custom debug config.
- Metadata debug summary for a compressed output.
- NDJSON file trace for a compressed output.
- Debug-enabled output equals debug-disabled output for the same fixture.
