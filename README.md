# opencode-headroom

`opencode-headroom` is a native OpenCode plugin that reduces large tool outputs
before they enter the model context. It keeps the exact original output in a
local Content-Addressable Context Repository (CCR), returns a compact result
with a retrieval hash, and exposes bounded tools for recovering only the
content that is needed.

The plugin provides deterministic per-tool policy, trusted file-backed output,
bounded retrieval defaults, bounded storage, session lifecycle cleanup, and
local cost telemetry. The plugin never learns preferences or changes policy
from observed behavior.

The current native engine also adds effect-parity coverage for code, diffs,
tables, HTML, and explicit mixed output; calibrated token accounting; bounded
session intent; exact shell-read protection; reversible lossless-first folds;
stale/superseded Read lifecycle management; and cross-turn span folding. These
deepen compression behavior without adding a proxy. Bounded process-local
decision reuse and per-strategy fail-open circuit breaking keep repeated work
cheap and isolate a failing compressor.

The implementation follows Headroom's routing, compression, and CCR concepts,
but does not run the Headroom proxy or require Headroom's Python/Rust runtime.

Native code compression currently targets Python and TypeScript/JavaScript
(including JSX/TSX). It parses the whole output into a Lezer syntax tree and
only folds routine function bodies longer than five non-empty lines. Imports,
decorators, declarations, classes, signatures, types, and Python docstring
summaries remain visible. Functions containing query terms or error/security
signals remain complete. Both the original and the marked candidate must parse
without syntax errors; unsupported, malformed, short, under-saving, or
over-compressed candidates are returned byte-exact instead. Any accepted fold
is still backed by the exact original in CCR.

## Requirements

- OpenCode with native plugin support
- Bun, OpenCode's plugin runtime and the runtime for persistent SQLite storage
- Node.js and npm only for package development and package smoke tests

## Install

```sh
bun add @dahuangggg/opencode-headroom
```

Add the plugin to `opencode.json`. A complete, conservative configuration is in
[`opencode.json.example`](./opencode.json.example). The minimum configuration
uses safe built-in defaults:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["@dahuangggg/opencode-headroom", { "engine": "native" }]]
}
```

## How it works

After a tool finishes, the plugin:

1. resolves one deterministic tool policy before reading any file-backed
   output;
2. preserves protected tools or rejects untrusted output paths;
3. skips empty, small, already-marked, and oversized output;
4. under the default `coding` profile, keeps short strong-error output and the
   just-completed Python/TS/JS working set byte-exact;
5. detects JSON, source code, search output, logs, diffs, tables, HTML,
   explicit mixed sections, or plain text;
6. under the default `coding` profile, applies a reversible type-native fold
   before the type-specific lossy compressor; it keeps the lossless fold as the
   floor when lossy selection cannot improve it;
7. accepts the candidate only when its structure and protected facts survive
   and the calibrated counter reports token savings; Python and TS/JS code is
   additionally reparsed after its language-valid retrieval comment is added;
8. commits the exact original and the chosen retrieve defaults to CCR;
9. keeps source and plain-text output from `cat`, `head`, `tail`, `sed -n`, and
   equivalent wrapped shell reads byte-exact, while leaving structured data and
   regenerable lockfiles eligible for compression;
10. folds exact or highly similar whole output only when a bounded same-session
   match exists, while committing another exactly retrievable CCR record;
11. after repetition matching, reuses only an identical content/query/profile
   compression or stable skip decision; a positive hit still commits the exact
   current original to session-scoped CCR;
12. after three consecutive failures in one detected strategy, bypasses only
   that strategy byte-exact for a 60-second cooldown; successful execution
   resets its failure count;
13. before each model request, freezes completed tool parts observed on an
   earlier transform and allows Read lifecycle to replace only a newly observed
   live `Read` of at least 512 UTF-8 bytes when the same live zone proves it
   stale;
14. folds repeated contiguous spans only in newly observed completed tool
   outputs, while frozen outputs remain available as references and constant
   line-number shifts are supported;
15. records local counters and latency without recording output, arguments, path
   content, or query text.

The plugin registers:

- `headroom_retrieve`, which retrieves CCR content from the current session;
- `headroom_stats`, which reports active CCR data and local cost telemetry.

Normal hook failures are fail-open: the original tool output remains in place.
The plugin does not change provider URLs, proxy traffic, or network transports.

Shell-read protection is content-aware. Source code and the plain-text fallback
remain exact because they may be patched byte-for-byte. Confident JSON, search,
log, diff, table, and HTML output remains compressible, as do generated
lockfiles such as `package-lock.json`, `pnpm-lock.yaml`, and `Cargo.lock`.

Cross-turn span folding uses OpenCode's native message-transform hook. The first
observation of a session is seeded without mutation. On later transforms,
completed tool-part identities already observed are frozen and only new parts
can be folded. Frozen outputs remain valid reference targets. Because OpenCode
reloads the stored raw message history for every request, the lifecycle tracker
also replays the exact changed representation that was previously sent. This
keeps the effective provider prefix byte-stable instead of letting a prior
pointer silently expand back to raw output. Replayed Read-lifecycle markers are
validated against CCR before any classification or scan-limit exit; if their
backing entry expired or was evicted, the tracker restores the raw Read instead
of sending an unretrievable pointer.

Since v0.3.1, the same live message-transform window provides an automatic MCP
compatibility fallback; no MCP-specific configuration is required.
OpenCode 1.17.13 can call `tool.execute.after` with the MCP SDK's raw
`CallToolResult` before it assembles the documented string output. Headroom
records only that missed call identity, then compresses the completed
request-local `state.output` after OpenCode has normalized it. The raw part in
OpenCode storage is not overwritten, cache-controlled history is not mutated,
and a future assembled after-hook result naturally stays on the normal fast path.

Headroom's net-cost frozen-prefix unlock is an opt-in transport policy and is
off in the reviewed default. This native plugin likewise never unlocks a frozen
part from guessed cache prices: OpenCode does not expose provider cache usage to
the transform hook. Live parts continue through the normal token-savings gate.

Read lifecycle management runs before span folding under the `coding` profile.
It derives `Read`, `Edit`, and `Write` history from completed OpenCode tool
parts. An old Read becomes stale after a later write to the same normalized
path, or superseded when a later Read fully covers its original offset/limit.
By default only stale Reads of at least 512 UTF-8 bytes are replaceable;
superseded, fresh, smaller, and partially overlapping Reads remain byte-exact.
Previously observed completed parts and the entire prefix through the latest
explicit cache-control marker are frozen. Every replacement uses a canonical
CCR hash, and Store failures leave the original untouched. The pass scans at
most 10,000 relevant operations per request; larger histories are left entirely
unchanged instead of being classified from a partial scan. Set `readLifecycle`
to `false` to disable Read replacement; cache-safe span folding remains enabled.

### Decision reuse and failure isolation

Whole-output repetition remains the first fast path. After that, a process-local
two-layer decision cache can reuse a deterministic compression result or a
stable skip decision only when the full content digest, relevance-query digest,
strength/profile, lossless mode, and trusted original-token input all match.
The key contains digests rather than raw source or query text. A positive hit
does not reuse another session's CCR record: it commits the current exact
original again, and a Store collision causes the marker-bearing candidate to be
rendered for the newly allocated hash before anything is emitted. Open-circuit
and exceptional outcomes never enter either decision-cache tier.

The cache has a 30-minute absolute TTL and one global LRU bounded to 512 entries,
2,000,000 retained compressed UTF-16 code units, and 250,000 code units for one
result. Skip entries retain only strategy, a bounded reason, and token-count
metadata; they retain no output. Session deletion clears same-session
repetition state but deliberately leaves reusable process decisions until TTL,
eviction, or plugin disposal. Compressed results can still contain sensitive
snippets, so process memory must be treated as sensitive just like CCR.

The router tracks consecutive exceptions separately for code, diff, JSON,
search, log, table, HTML, and text. Three failures open only that strategy for
60 seconds; while open, the exact input is returned and the compressor is not
called. Any clean execution resets that strategy, and a post-cooldown trial
either closes or reopens it. Headroom's reviewed reference applies the same
three-failure/60-second fail-open effect at pipeline scope; the native adapter
uses finer isolation because its content strategies execute independently.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `engine` | `"native"` | Compression engine; currently only `native` is supported. |
| `profile` | `"coding"` | `coding` matches Headroom's low activation thresholds and lossless-first pipeline; `legacy` restores the earlier thresholds, lossless setting, and Read-lifecycle default. |
| `thresholdTokens` | profile default (`25` for `coding`) | Global estimated-token threshold. An explicit value overrides the profile. |
| `thresholdChars` | profile default (`25` for `coding`) | Global character threshold. An explicit value overrides the profile; compression is considered when either threshold is reached. |
| `ttlHours` | `24` | Global CCR retention time. |
| `storage.kind` | `"auto"` | `auto`, `memory`, or `bun-sqlite`. |
| `storage.path` | `.headroom/ccr.sqlite` | SQLite path relative to the OpenCode worktree. |
| `storage.maxEntries` | `10000` | Maximum active CCR entries before oldest-first eviction. |
| `storage.busyTimeoutMs` | `5000` | Non-negative SQLite lock wait in milliseconds. |
| `toolPolicy.default.action` | `"compress"` | Fallback action for a tool with no rule or built-in match. |
| `toolPolicy.default.strength` | `"balanced"` | Fallback compression strength. |
| `toolPolicy.rules` | `[]` | Ordered, explicit per-tool rules; first match wins. |
| `outputFiles.allowedRoots` | `["."]` | Roots from which trusted file-backed output may be read. |
| `outputFiles.trustedTools` | `["Bash"]` | Tools allowed to supply file-backed output metadata. |
| `skipTools` | `["headroom_*", "ctx_*"]` | Deprecated compatibility input translated to a preserve rule. |
| `maxOutputChars` | `250000` | Maximum content considered for compression or file-backed reads. |
| `debug` | `false` | Attach or write decision traces. |
| `debugLevel` | `"summary"` | `summary` or `trace`. |
| `debugSink` | `"metadata"` | `metadata`, `file`, or `both`. |
| `debugPath` | `.headroom/debug.ndjson` | Worktree-relative debug file path. |
| `readLifecycle` | profile default (`true` for `coding`) | Replace eligible live stale OpenCode Read results of at least 512 UTF-8 bytes before model requests. |

Invalid enums, empty selectors, non-positive limits, and incompatible preserve
rules fail during plugin initialization.

Use `"profile": "legacy"` to restore the earlier `2000` token / `8000`
character activation thresholds and disable the lossless-first and Read
lifecycle stages without changing any tool policies. Explicit thresholds and
an explicit `readLifecycle` value still override profile defaults.

The lossless-first stage follows Headroom's format-native approach. Consecutive
identical log/text rows become a counted repeat marker, and grep rows use
ripgrep heading form so repeated paths are printed once. Homogeneous JSON arrays
of scalar records use a compact table encoding when it saves at least 30%.
Line transforms reproduce the exact bytes; JSON tables reproduce every value,
type, field, and row in order. Each transform is round-trip checked before use,
and the exact original remains the CCR source of truth. The lossy candidate is
still validated against the original, not merely against the folded
intermediate result.

Search, log, JSON-array, and tabular compression use Headroom-style adaptive
information sizing after priority selection. Repetitive filler reaches its
information-saturation point sooner, while diverse filler retains more rows.
The relevance query reserves 300 characters for top-level scalar tool
arguments, so a long user prompt cannot hide the active path or search pattern.
Log query matches are required rows and seed the same bounded neighboring
context used for errors and warnings.
JSON and table candidates are ranked by normalized information rarity and
distributed position coverage; semantic and numeric outliers are protected.
Strength-specific row budgets remain safety ceilings: required rows do not spend
the adaptive filler budget. When debug output is enabled, the compressor summary
records the selected `k`, diversity, unique-group count, bias, knee, and zlib
adjustment without recording the analyzed content or query.

Unified diffs use a parsed file-and-hunk model instead of line filtering. Inputs
below 50 lines remain exact. Eligible hunks keep two context lines on either
side of every change, plus pre-diff text, file metadata, rename/mode lines, and
`No newline` markers. Diffs above 20 files retain error/security files first,
then query matches, before change-dense routine files; files above 10 hunks use
the same priority order while keeping the first and last as anchors. The candidate is used only when it
saves at least 20% of lines. Error and security changes remain hard-protected;
ordinary omitted files and hunks remain exactly recoverable through CCR.

## Deterministic tool policy

`toolPolicy.rules` is the user extension point for tool-specific behavior:

```json
{
  "toolPolicy": {
    "default": {
      "action": "compress",
      "strength": "balanced"
    },
    "rules": [
      {
        "id": "keep-database-export-exact",
        "tools": ["mcp_*_export"],
        "action": "preserve"
      },
      {
        "id": "aggressive-build-logs",
        "tools": ["Bash"],
        "action": "compress",
        "strength": "aggressive",
        "minimum": "always",
        "ccr": { "ttlHours": 6 },
        "retrieve": {
          "defaultMode": "tail",
          "maxChars": 4000
        }
      }
    ]
  }
}
```

Rules are resolved in this order:

1. non-overridable recursion protection for `headroom_*`;
2. user rules in declaration order; the first matching rule wins;
3. the deprecated `skipTools` list as one compatibility preserve rule;
4. the built-in preserve default for `ctx_*`;
5. built-in preserve defaults for `Read`, `Edit`, `Write`, and `apply_patch`;
6. `toolPolicy.default`.

Tool patterns are case-insensitive globs. `*` matches any sequence and `?`
matches one character. Explicit user rules can override legacy, `ctx_*`, and
exact-content tool defaults; compressing an exact-content tool should be an
intentional decision. They cannot override `headroom_*` recursion protection.
Marker, output-path, size, content-level code/diff, and fail-open safety checks
still apply after policy resolution.

Rule fields:

- `action`: `preserve` or `compress`;
- `strength`: `conservative`, `balanced`, or `aggressive`; stronger compression
  uses smaller internal budgets;
- `minimum`: `"always"` or a positive `{ "tokens", "chars" }` override. Any
  omitted field falls back to the corresponding global threshold;
- `ccr.ttlHours`: positive per-tool TTL override;
- `retrieve.defaultMode`: `summary`, `head`, `tail`, or `full`;
- `retrieve.maxChars`: positive hard limit persisted with the CCR entry.

A `preserve` rule cannot also set strength, minimum, CCR, or retrieve options.
Policy is configured explicitly and is deterministic: telemetry is
observational only and never edits, reorders, or creates rules.

### `skipTools` compatibility

`skipTools` remains accepted for 0.1 configurations, but is deprecated. It is
translated to a compatibility preserve rule after all explicit user rules.
Move custom entries to `toolPolicy.rules`; this makes ordering and intent
visible. `headroom_*` remains protected as a structural recursion invariant;
`ctx_*` remains a built-in preserve default when `skipTools` is removed.

## Trusted file-backed output

OpenCode tools may return a truncated display plus `outputPath`, `outputFile`,
or `outputRef` metadata. The plugin reads that file only when the display is
marked as truncated and both trust conditions pass:

- the tool matches `outputFiles.trustedTools`;
- the canonical file is inside an `outputFiles.allowedRoots` directory.

The defaults allow only `Bash` and only the current worktree (`"."`). The reader
rejects non-regular files, symlink escapes, path swaps, unreadable paths, and
files above `maxOutputChars`; descriptor reads are also capped so a concurrently
growing file cannot bypass the limit. On rejection, the plugin keeps the
displayed tool output unchanged, skips compression with `source_denied` (or
`too_large`), and exposes the reason through local stats even when debug is off.
`outputFiles` and both subfields are optional; an omitted subfield uses its
default. Set `trustedTools` to `[]` to disable file-backed reads; expand either
list only for tools and directories you trust.

Paths may appear in OpenCode result metadata and optional debug traces. They are
not copied into telemetry snapshots.

## Storage, lifecycle, and privacy

CCR stores the exact uncompressed output and must be treated as sensitive:

- `memory` is process-local and disappears when the plugin stops;
- `bun-sqlite` persists at `storage.path`;
- `auto` uses SQLite when Bun is available and falls back to memory only when
  the runtime does not provide Bun, reported as `unsupported_runtime`.

`auto` does not hide SQLite path, permission, migration, corruption, or lock
errors. Under Bun those initialization failures are surfaced. Choose `memory`
explicitly when persistence is not wanted.

Both adapters prune expired entries and enforce `storage.maxEntries`. When the
limit is reached, the oldest active entries are evicted first. SQLite uses
`BEGIN IMMEDIATE` for writes, the configured busy timeout (5000 ms by default),
`secure_delete=ON`, and best-effort owner-only file permissions.

When OpenCode emits `session.deleted`, the plugin deletes that session's CCR
entries, latest-user-intent state, repetition fingerprints, per-session
telemetry, cached Read-lifecycle hash/digest references, and the sent-context
frontier. Process-global historical telemetry and reusable compression
decisions remain until the plugin is disposed; decisions are independently
TTL/LRU bounded and contain no raw skip payload. The plugin's `dispose` hook
clears bounded session and decision state and closes the store; SQLite close is
idempotent. Repetition and Read-lifecycle state store
bounded fingerprints, hashes, and digests. Context lifecycle additionally keeps
only changed sent representations needed for byte-exact replay, bounded to
256,000 characters per session across at most 256 sessions; unchanged raw
output is represented only by digests. Exact CCR recovery bytes remain owned by
CCR. Sessions with retained changed representations are not evicted; if all
slots require replay, a new session fails open without mutation. Same-session
transforms are serialized, deletion waits for in-flight transforms, and dispose
drains the bounded transform queue before closing CCR.

### SQLite schema v2

Opening an older database automatically migrates it to schema version 2:

- CCR entries gain persisted default retrieve mode and maximum-character
  columns;
- the collision-history table replaces stored original content with SHA-256
  content digests and is rebuilt/cleaned to contain only active keys;
- expired rows are pruned and the capacity limit is enforced;
- the database `user_version` is set to `2`.

The migration preserves active CCR originals because exact retrieval still
requires them. A database with a schema newer than version 2 is rejected rather
than downgraded. Back up a persistent database before upgrading if its retained
content matters.

TTL, eviction, session deletion, `secure_delete`, and the v2 digest migration
reduce retention but are not a complete secure-erasure guarantee for backups,
copied databases, or filesystem snapshots. Delete the database and its side
files when immediate erasure is required.

Add these patterns to each consumer repository, adjusted for custom paths:

```gitignore
.headroom/
.DS_Store
*.sqlite-shm
*.sqlite-wal
*.sqlite-journal
headroom-debug*.ndjson
```

## Retrieval

Compressed output contains a 24-character CCR hash. A bare retrieve now returns
a bounded summary, not the full original:

```text
headroom_retrieve(hash="0123456789abcdef01234567")
```

The standard default is `summary` with a 12000-character hard limit. A matching
tool policy may persist a different `head`, `tail`, or `full` default on that
entry. To recover the exact original, request full explicitly and do not set a
character cap:

```text
headroom_retrieve(hash="0123456789abcdef01234567", mode="full")
```

Available modes:

- `query`: Unicode-aware matching with configurable context and match count;
- `range`: a 1-based line interval;
- `head` or `tail`: a bounded number of lines;
- `summary`: metadata and a short preview;
- `full`: the original content, optionally clipped only when `maxChars` is set.

For compact single-line JSON, partial modes use a line-oriented pretty view
without changing the exact content returned by `full`. Every bounded mode counts
headers and truncation metadata inside its `maxChars` limit.

Retrieval is session-scoped. An expired, evicted, deleted, or foreign-session
hash returns a not-found message; rerun the original tool to recreate it.

## Stats and local telemetry

`headroom_stats` includes active CCR totals plus local telemetry. With
`sessionOnly: true`, both sections are restricted to the current session. The
telemetry section reports:

- requested and active storage adapters and any bounded fallback reason;
- compressed, skipped, and error counts plus reason distribution;
- gross estimated token savings;
- retrieval count, output tokens by mode, misses, and full-retrieve rate;
- latency count, total, and maximum;
- estimated net savings.

Net savings is deliberately allowed to be negative:

```text
estimated net savings = gross estimated savings - all retrieve output tokens
```

Telemetry is in-memory and observational. Its event interface accepts only
identifiers, enums, counts, and durations; it does not retain original output,
tool arguments, path content, or query text. Debug traces are separate and may
contain session, call, tool, and path metadata.

## Migrating from 0.1 to 0.2

Existing 0.1 configuration remains parseable, but review these behavior changes:

1. Replace custom `skipTools` entries with ordered `toolPolicy.rules` using
   `action: "preserve"`. Explicit user rules now take priority over the legacy
   compatibility rule and overridable built-in defaults; `headroom_*` recursion
   protection remains structural.
2. A bare `headroom_retrieve` now returns a bounded summary. Use
   `mode: "full"` without `maxChars` wherever exact full recovery is required.
3. `auto` falls back only on an unsupported runtime. SQLite initialization and
   migration failures under Bun now fail visibly.
4. File-backed output defaults to `Bash` inside the worktree. Configure
   `outputFiles.allowedRoots` and `trustedTools` for any additional source.
5. CCR capacity now defaults to 10000 entries, and the SQLite busy timeout is a
   public `storage.busyTimeoutMs` option with a 5000 ms default. Adjust either
   value explicitly when the workload requires it.
6. Persistent databases migrate in place to schema v2. Back up important CCR
   data before the first 0.2 startup.
7. Session deletion now removes its CCR entries and per-session telemetry, and
   plugin disposal closes persistent resources.

A direct replacement for a custom 0.1 skip list is:

```json
{
  "toolPolicy": {
    "rules": [
      {
        "id": "preserve-custom-tools",
        "tools": ["my_exact_tool", "mcp_*_export"],
        "action": "preserve"
      }
    ]
  }
}
```

## Troubleshooting

### An output was not compressed

It may match a preserve rule, be below both selected thresholds, contain an
existing CCR marker, exceed `maxOutputChars`, lack enough safe type-specific
folding opportunities, fail a protected-fact or structure gate, or produce no
estimated savings. Enable summary debug metadata to see the resolved rule,
strength, thresholds, and decision reason.

### SQLite was not created

Check `headroom_stats` for `storage adapter`. Outside Bun, `auto` reports
`auto -> memory` with `unsupported_runtime`. Under Bun, inspect the surfaced
path, permission, migration, or lock error; the plugin will not silently switch
to memory. Use `storage.kind: "memory"` explicitly if that is the desired
behavior.

### A hash cannot be retrieved

It may belong to another session or have expired, been evicted, or been deleted
with its session. A bare call is now a summary; use explicit `mode: "full"` for
exact recovery.

### A file-backed result was ignored

The tool must be trusted, the canonical path must remain within an allowed
root, the target must be a regular file, and its byte and character sizes must
fit `maxOutputChars`. Debug metadata records a bounded rejection reason.

## Development and release checks

```sh
bun install
bun test tests
bun run typecheck
npm run build
bun run bench:quality
bun run bench:check
bun run bench:perf
npm run lint:package
npm run test:package
npm audit --omit=dev
```

`bun.lock` is the canonical lockfile. `bench:quality` enforces the pinned
Headroom effect-parity corpus. A bounded diff is structurally valid when it
retains diff/file/hunk framing and changed lines; fixture-specific protected
facts, rather than every routine file, remain mandatory. `bench:check` is deterministic and does not
rewrite the tracked cost report; `bench:report` is the explicit report writer.
`bench:perf` reports calibrated token counting cold/hot paths separately and
measures fixed-seed router, Store put/get, ordinary non-repetition compression,
cross-session hot decision-cache reuse, bounded retrieval, complete tool and
message-transform hooks, SQLite
worker-concurrent writes, and cold-start p50/p95/max results without writing a
report. It blocks when either P0 10 KiB memory-backed `tool.execute.after` or
Read-lifecycle `messages.transform` p95 is not below 50 ms; the larger and
SQLite rows remain reviewed baselines.
`lint:package` checks npm-normalized manifest metadata, self-dependencies,
public export paths, packed export targets, and conflict-copy files. The
package smoke removes `dist`, packs from a clean state, validates
the intended surface, installs into a temporary consumer, runs `npm ls --all`,
typechecks the public configuration from a TypeScript consumer, imports both
public entry points, verifies Node's observable `auto -> memory` unsupported-
runtime fallback stats, and initializes the plugin with Bun.

Before publication, also load the freshly installed tarball through a real
OpenCode host. Point the host at the temporary consumer's installed
`dist/plugin.js` and verify that it initializes SQLite schema v2 without making
a model request.

See [`DESIGN.md`](./DESIGN.md) for module boundaries and release invariants.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
