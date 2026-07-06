# OpenCode Headroom Native Plugin Design

Date: 2026-07-06

## Summary

Build a root-level npm package, `opencode-headroom`, that implements a Headroom-compatible native OpenCode plugin. The plugin compresses large tool outputs after execution, stores the original output in CCR, and exposes native OpenCode tools for retrieval and stats.

The first version is native and self-contained. It does not run a Headroom proxy, patch OpenCode transport, modify provider `baseURL`, call Python/Rust Headroom runtime code, or use Kompress/ML. It should still follow Headroom's architecture and invariants so a future Headroom backend can be added behind the same engine interface.

## Goals

- Compress large OpenCode tool outputs via `tool.execute.after`.
- Preserve reversibility through CCR: every emitted hash must retrieve the exact original output.
- Keep compression behavior aligned with Headroom concepts: `ContentRouter`, SmartCrusher-style JSON handling, search/log/text compressors, and CCR markers.
- Coexist with context-mode by running only after tool execution and skipping `ctx_*` tools by default.
- Keep installation lightweight and offline-friendly.
- Provide a clean engine abstraction so future Headroom-backed implementations can plug in without rewriting OpenCode hook code.

## Non-Goals

- No OpenCode provider injection.
- No `baseURL` override.
- No `fetch`, `http`, `https`, `NODE_OPTIONS`, or child-process transport patching.
- No Headroom proxy sidecar in the default path.
- No direct Python/Rust Headroom runtime bridge in P0.
- No conversation-history compression.
- No `experimental.chat.system.transform` or `experimental.session.compacting` in P0.
- No ML/Kompress compression in P0.

## Package Layout

The current repository root becomes the npm package. The existing `headroom/` directory remains reference source only.

```text
.
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    plugin.ts
    config.ts
    engine/
      types.ts
      native.ts
      router.ts
    compressors/
      json.ts
      search.ts
      log.ts
      text.ts
    store/
      types.ts
      ccr.ts
      memory.ts
      sqlite.ts
      sqlite-bun.ts
    tools/
      retrieve.ts
      stats.ts
    token.ts
    markers.ts
  tests/
    fixtures/
    *.test.ts
  opencode.json.example
  DESIGN.md
```

## Configuration

Default config:

```json
{
  "engine": "native",
  "thresholdTokens": 2000,
  "thresholdChars": 8000,
  "ttlHours": 24,
  "storage": {
    "kind": "auto",
    "path": ".headroom/ccr.sqlite"
  },
  "skipTools": ["headroom_*", "ctx_*"],
  "maxOutputChars": 250000,
  "debug": false
}
```

OpenCode usage:

```json
{
  "plugin": [
    ["opencode-headroom", {
      "engine": "native",
      "thresholdTokens": 2000,
      "ttlHours": 24
    }]
  ]
}
```

`engine` supports only `"native"` in P0. The type allows future values such as `"headroom-wasm"` or `"headroom-http"`, but unsupported engines must fail loud at plugin init rather than silently falling back.

## OpenCode Integration

The plugin registers:

- `tool.execute.after`
- `tool.headroom_retrieve`
- `tool.headroom_stats`

Hook behavior:

1. Read `input.tool`, `input.sessionID`, `input.callID`, `input.args`, and `output.output`.
2. Skip when output is small, empty, already has a CCR marker, or the tool matches a skip pattern.
3. Call the configured compression engine.
4. If compression succeeds, store the original content and replace `output.output`.
5. Attach lightweight metadata to `output.metadata.headroom`.
6. If anything fails, leave `output.output` unchanged.

`tool.execute.after` must never throw for normal compression failures. Native tool execution may return explicit errors for bad user input, such as an invalid hash.

## Engine Abstraction

The OpenCode plugin does not call compressors directly. It calls a `CompressionEngine`.

```ts
export interface CompressionEngine {
  name: string;
  compress(input: ToolOutputCompressionInput): Promise<ToolOutputCompressionResult>;
  retrieve(hash: string, query?: string): Promise<RetrieveResult>;
  stats(sessionID?: string): Promise<StatsResult>;
}
```

P0 implementation:

```text
NativeHeadroomCompatibleEngine
  -> ContentRouter
  -> compressor
  -> CCRStore
```

This preserves a path for future real Headroom integrations while keeping P0 fully native.

## Content Detection

Detection follows Headroom's ordering and safety posture:

1. Empty or whitespace output: passthrough.
2. Strip full-output envelopes for detection only:
   - `<output>...</output>`
   - `<stdout>...</stdout>`
   - `<stderr>...</stderr>`
   - `<tool_result>...</tool_result>`
   - optional `<returncode>...</returncode>` prefix
3. JSON array/object.
4. Git diff. P0 detects but does not lossy-compress diffs.
5. Search results: `file:line:content`, `file-line-content`, and common `rg` formats.
6. Logs/build output: error/warn levels, timestamps, pytest/npm/cargo/jest/make markers, stack traces.
7. Plain text fallback.

Detection must not mutate the content passed to storage. The stored original is always byte-for-byte the original `output.output` string.

## Compression Rules

### JSON Compressor

The JSON compressor is SmartCrusher-lite, not generic truncation.

For JSON arrays:

- Preserve valid JSON output when possible.
- For array-of-objects, kept items must be original items from the array.
- Keep first and last rows.
- Keep rows containing error/failure/warning/security/todo indicators.
- Keep rows whose key set differs from the dominant shape.
- Keep representative rows up to `maxItemsAfterCrush`.
- Append a Headroom-style sentinel when rows are dropped:

```json
{"_ccr_dropped":"<<ccr:HASH N_rows_offloaded>>"}
```

For non-array JSON or heterogeneous structures:

- Prefer safe structural summary plus CCR marker.
- Do not emit fake records that look like original business data.
- If safe compression cannot beat the original, passthrough.

### Search Compressor

The search compressor follows Headroom search semantics:

- Parse records into `{ file, lineNumber, content }`.
- Preserve file paths and line numbers exactly.
- Score by query/tool args overlap and priority patterns:
  - error/fail/fatal/exception
  - warning
  - todo/fixme/hack
  - auth/secret/password/security
- Select:
  - first and last match per file
  - highest scoring matches
  - bounded by `maxMatchesPerFile`, `maxFiles`, `maxTotalMatches`
- Output remains grep-like:

```text
src/auth.ts:10:ERROR auth failed
src/auth.ts:42:warning auth retry
[... and 18 more matches in src/auth.ts]
[Retrieve more: hash=0123456789abcdef01234567]
```

Line numbers must not be dropped or renumbered.

### Log Compressor

The log compressor follows Headroom log semantics:

- Classify lines as `ERROR`, `FAIL`, `WARN`, `INFO`, `DEBUG`, `TRACE`, or `UNKNOWN`.
- Detect log format: `pytest`, `npm`, `cargo`, `make`, `jest`, or `generic`.
- Keep:
  - first and last errors/failures
  - warnings up to limit
  - stack trace blocks up to limit
  - summary lines
  - configurable context lines around selected error lines
- Deduplicate warnings conservatively. Different message prefixes must not collapse into one warning.
- Output selected original lines in original order plus omitted summary and retrieve marker.

Example:

```text
npm ERR! something broke
Traceback (most recent call last)
  File "app.py", line 10
[120 lines omitted: 5 ERROR, 12 WARN, 80 INFO]
[Retrieve more: hash=0123456789abcdef01234567]
```

### Text Compressor

The text compressor is extractive.

- Never paraphrase.
- Keep original sentences/paragraph fragments.
- Prefer headings, first/last paragraphs, error/security/todo lines, and query/tool-arg matches.
- Remove near-duplicate segments conservatively.
- Emit a retrieve marker when content is dropped.

## CCR Store

CCR is mandatory for any lossy or partial compression.

Hash:

```text
sha256(originalContent).slice(0, 24)
```

The hash in the marker must exactly match the store key. If the store write fails, the compressor must return passthrough and emit no marker.

Storage adapter:

```ts
export interface CCRStore {
  put(entry: CCRPutInput): Promise<CCREntry>;
  get(hash: string): Promise<CCREntry | null>;
  stats(sessionID?: string): Promise<CCRStats>;
  pruneExpired(now?: Date): Promise<number>;
}
```

P0 adapters:

- `MemoryCCRStore` for tests and fallback.
- `AutoCCRStore` that prefers `bun:sqlite` when available.
- A storage interface that can later host `better-sqlite3` without changing engine code.

SQLite schema:

```sql
CREATE TABLE IF NOT EXISTS ccr_entries (
  hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  call_id TEXT,
  tool TEXT,
  strategy TEXT NOT NULL,
  original_content TEXT NOT NULL,
  compressed_content TEXT NOT NULL,
  original_tokens INTEGER NOT NULL,
  compressed_tokens INTEGER NOT NULL,
  original_chars INTEGER NOT NULL,
  compressed_chars INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retrieval_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ccr_session ON ccr_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_ccr_expires_at ON ccr_entries(expires_at);
```

File permissions should be private on POSIX when possible.

## Native Tools

### `headroom_retrieve`

Args:

```ts
{
  hash: string;
  query?: string;
}
```

Behavior:

- Validate 24-character hex hash.
- Return exact original content for the hash.
- Increment retrieval count.
- If expired/missing, return an actionable miss message:
  - rerun command for command output
  - reread file for file output
  - mention TTL

### `headroom_stats`

Args:

```ts
{
  sessionOnly?: boolean;
}
```

Behavior:

- Show entries, original/compressed tokens, estimated saved tokens, retrievals, active engine, fallback counters, and skipped outputs.
- Session stats use the current native tool context `sessionID` when available.

## Token Estimation

P0 uses deterministic estimated tokens:

```text
tokens = ceil(chars / 4)
```

All stats label these as estimates. This avoids tiktoken or model-specific dependencies in P0.

## Context-Mode Coexistence

Default skip tools:

- `headroom_*`
- `ctx_*`

Rationale:

- context-mode routes before execution and owns FTS/sandbox tools.
- opencode-headroom compresses after execution only.
- Skipping `ctx_*` avoids double-compressing outputs that context-mode may already shape.

Users can override `skipTools`, but defaults should be conservative.

## Failure Modes

- Compression exception: passthrough.
- Store write failure: passthrough.
- Unsupported engine: fail at plugin init.
- Invalid retrieve hash: return validation error.
- Missing/expired hash: return recoverable miss message.
- Compressed output not shorter than original: passthrough and no store write.
- Already contains CCR marker: passthrough to avoid nested markers.

## Testing

Use Vitest.

Required tests:

- OpenCode plugin factory exposes `tool.execute.after`, `headroom_retrieve`, and `headroom_stats`.
- Small output under threshold is unchanged and not stored.
- Already marked output is unchanged.
- `ctx_*` and `headroom_*` tools are skipped by default.
- JSON array fixture compresses by at least 60% estimated tokens and retrieves exact original.
- JSON sentinel hash matches store key.
- Search fixture keeps file paths and line numbers, compresses by at least 70%, retrieves exact original.
- Log fixture keeps errors, stack traces, warnings, summaries, compresses, retrieves exact original.
- Text fixture is extractive: every emitted non-marker segment exists in original.
- Store TTL expiry produces a miss.
- `headroom_stats` reports saved tokens and retrieval count.
- Hook never throws on compressor/store failures.

Benchmark target:

- `tool.execute.after` p95 under 50 ms on P0 fixtures when using memory store.

## Future Headroom Backend Path

P0 ships only the native engine. Future engines can implement the same `CompressionEngine` interface:

- `headroom-wasm`: if Headroom exposes a WASM/Rust core consumable from Node/Bun.
- `headroom-http`: optional sidecar adapter that calls Headroom's compression API. This must be documented as optional and not part of the no-proxy default path.
- `headroom-cli`: optional command adapter only if a stable CLI compression contract exists.

The OpenCode hook layer must not change when these are added.

## Acceptance Criteria

- The package builds and tests with local Vitest.
- No runtime dependency on `headroom-ai`, Python, Rust, or Headroom proxy.
- P0 config works from `opencode.json`.
- Retrieve returns exact original output for every emitted marker.
- The plugin never changes OpenCode provider or network transport settings.
- Design remains compatible with future Headroom engines through `CompressionEngine`.
