# opencode-headroom Design

## Purpose and release scope

`opencode-headroom` 0.2.0 is a native OpenCode plugin that compresses large tool
outputs after execution and preserves exact originals in a local
Content-Addressable Context Repository (CCR). It adopts Headroom's routing,
compression, and retrieval ideas without requiring a proxy, provider rewrite,
Python process, Rust binary, or ML model.

The package has two public entry points:

- `@dahuangggg/opencode-headroom` exports the plugin as `default`, `server`, and
  `HeadroomNativePlugin`, plus public engine and store types;
- `@dahuangggg/opencode-headroom/plugin` exports the plugin implementation directly.

Version 0.2 adds five deep boundaries around the native engine: deterministic
tool policy, trusted file-backed output, bounded CCR lifecycle, Read lifecycle,
and local telemetry. Each boundary has a small public interface and can change
internally without rewriting the OpenCode hook.

## Runtime flow

```text
OpenCode tool result
  -> resolve ToolPolicy (first explicit match)
  -> preserve or trusted OutputFileSource
  -> threshold / marker / size gates
  -> NativeHeadroomCompatibleEngine
     -> ContentRouter
     -> JSON | search | log | text | code | diff | table | HTML compressor
     -> protected-fact + structure + calibrated-token candidate gate
     -> bounded same-session repetition matcher
     -> CCRStore commit with retrieve defaults
  -> compressed output + canonical hash + metadata
  -> LocalTelemetryAggregator

headroom_retrieve -> session-scoped CCR get -> bounded view or explicit full
headroom_stats    -> CCR stats + global/session telemetry snapshot
messages.transform -> stale/superseded Read CCR fold -> repeated-span fold
session.deleted   -> delete CCR rows + intent/repetition/Read/telemetry state
dispose           -> clear session state + close the active CCR adapter
```

Normal hook, compression, debug, and telemetry failures must never corrupt or
replace the original output. Storage initialization is different: an explicit
or Bun-backed persistent adapter failure is surfaced during plugin startup.

## Module boundaries

### OpenCode adapter

`src/plugin.ts` owns OpenCode integration only:

- normalizes plugin configuration and resolves the worktree;
- resolves policy before any file-backed output read;
- converts hook input into the engine interface;
- registers `headroom_retrieve` and `headroom_stats`;
- applies Read lifecycle before repeated-span folding in the message transform;
- attaches compact `output.metadata.headroom` data;
- handles session deletion and plugin disposal;
- records safe local telemetry and optional debug traces.

Content-specific algorithms, storage SQL, pattern compilation, and path trust
checks remain behind their own modules.

### Configuration and tool policy

`src/config.ts` validates all public limits and enums at initialization.
`src/policy.ts` compiles tool patterns once and resolves a pure,
telemetry-independent `ResolvedToolPolicy` for each tool.

The `coding` profile enables Read lifecycle by default; `legacy` disables it.
An explicit boolean `readLifecycle` value overrides either profile. This pass
is independent of per-tool compression policy because it acts only after a
later operation proves an old Read stale or fully superseded.

Resolution order is part of the 0.2 contract:

1. non-overridable recursion protection for `headroom_*`;
2. explicit user rules in declaration order, first match wins;
3. deprecated `skipTools`, translated to one compatibility preserve rule;
4. the built-in preserve default for `ctx_*`;
5. built-in preserve defaults for `Read`, `Edit`, `Write`, and `apply_patch`;
6. the configured default action and strength.

Patterns are anchored, case-insensitive globs with `*` and `?`. Explicit rules
can override compatibility, `ctx_*`, and exact-content defaults, but cannot
override `headroom_*` recursion protection. Lower-level invariants, including
output-path containment, marker detection, maximum size, content-level
code/diff safety gates, canonical CCR keys, and fail-open output handling, are
not policy decisions.

A rule has a stable ID, selector list, and `preserve` or `compress` action. A
compress rule may override:

- `strength`: `conservative`, `balanced`, or `aggressive`;
- `minimum`: `always` or per-tool token/character thresholds;
- `ccr.ttlHours`;
- `retrieve.defaultMode` and `retrieve.maxChars`.

Global storage configuration also exposes positive `maxEntries` and a
non-negative `busyTimeoutMs`, defaulting to 10000 and 5000 respectively.

Preserve rules reject compression-only options. Policy is explicit and static;
the plugin never infers preferences, learns from telemetry, or silently rewrites
configuration.

### Trusted output-file source

`src/source/output-file.ts` is the only module allowed to turn OpenCode
`outputPath`, `outputFile`, or `outputRef` metadata into content. Reads occur
only for displays recognized as truncated.

The default trust envelope is:

```json
{
  "allowedRoots": ["."],
  "trustedTools": ["Bash"]
}
```

Roots are resolved relative to the OpenCode worktree. The source resolves real
paths, requires the tool to match, verifies containment, opens without following
the final symlink, requires a regular file, rechecks device/inode identity, and
enforces the same byte/character safety cap. A rejected source returns a bounded
reason and the hook continues with the displayed output.

### Engine, router, and compression profiles

The OpenCode adapter calls a narrow engine interface:

```ts
interface CompressionEngine {
  name: string;
  compress(input: ToolOutputCompressionInput): Promise<ToolOutputCompressionResult>;
  retrieve(
    hash: string,
    request?: RetrieveRequest,
    sessionID?: string,
  ): Promise<RetrieveResult>;
  stats(sessionID?: string): Promise<StatsResult>;
}
```

The router unwraps supported whole-output envelopes for detection and rendering,
then classifies JSON, source code, git diffs, search results, logs, tables,
HTML, or text. Explicit tagged mixed sections are routed independently while
their framing remains intact. Code compression preserves imports,
declarations, signatures, types, errors, and query-relevant symbols. Its
supported language boundary is Python and TypeScript/JavaScript, including
JSX/TSX. Pure-JavaScript Lezer parsers validate the original before selection
and the final output after a language-valid CCR comment is appended. Only
routine function bodies above five non-empty lines are replaceable; Python
decorators and the first docstring line remain visible. A function containing
a query term or error/security signal stays complete. Parse failures, unknown
languages, fewer than 100 estimated tokens, less than 20% token savings, or a
candidate retaining less than 5% of the original tokens all fail open to the
byte-exact input. Diff compression parses files and hunks, preserves Git
metadata and two context lines around changes, and leaves inputs below 50 lines
unchanged. Above the private 20-file or 10-hunk ceilings, query matches and
error/security priority signals rank ahead of routine change density, with
error/security taking precedence when the ceiling fills; first and last hunks
remain anchors. Candidates saving less than 20% of lines are rejected. The router
hard-protects error and security changes while allowing ordinary omitted
files/hunks to rely on CCR. The exact original string, not the routed view, is
offered to CCR.

The public `coding` profile is the default and uses Headroom's 25-token and
25-character activation thresholds. It also enables the lossless-first stage:
repeated log/text rows use counted run folding and grep rows use ripgrep heading
form. Homogeneous scalar-record JSON arrays use a schema-header table encoding
when the semantic round trip is exact and byte savings reach 30%. Line folds
have byte-exact inverses; JSON tables preserve values, types, field order, and
row order. The type compressor then runs on the folded form; if its candidate
fails or saves nothing, the verified fold remains the floor. Final structure,
protected-fact, and token gates compare against the original routed payload.
`legacy` restores the plugin's earlier 2000-token and 8000-character thresholds
and disables this stage. Explicit threshold options override either profile's
activation values.

`conservative`, `balanced`, and `aggressive` map to private per-compressor
budgets. The public policy does not expose row counts, scoring weights, stack
limits, or text ratios. A proposed result is accepted only when type-specific
structure and protected facts survive and the calibrated counter reports fewer
tokens than the original. The counter can wrap a locally available
model-specific tokenizer; otherwise it uses deterministic calibration for
prose, CJK, code, and high-entropy content.

Search, log, JSON-array, and tabular filler budgets are adaptive within those
private ceilings. The sizer follows Headroom's information-saturation design:
bounded 64-bit SimHash grouping estimates diversity, cumulative bigram coverage
supplies a Kneedle candidate, profile bias maps conservative/balanced/aggressive
behavior, and a level-1 zlib ratio check can expand an under-representative
prefix. Spaceless CJK content uses character bigrams. JSON and table filler is
ranked by normalized token rarity and deterministic distributed anchors;
structural, semantic, query, and three-standard-deviation numeric outliers are
selected before sizing. Required rows never consume the resulting filler `k`.
The debug decision contains numeric and enum diagnostics only, never source rows
or query text.

### Bounded session context and repetition

The latest real user text is retained per session with fixed session and
character limits. It is combined with scalar tool arguments only in memory to
rank relevant content; raw intent, arguments, and queries never enter
telemetry.

After a normal CCR commit, `SessionRepetitionStore` retains only bounded content
signatures and line fingerprints. A later exact or at-least-90%-similar result
in the same session may become a short repetition pointer, but it still travels
through the canonical Store commit and `mode=full` returns the new call's exact
bytes. Matches cannot cross sessions, expire with their owning entry, and are
removed on session deletion or disposal.

### Read lifecycle

`ReadLifecycleManager` scans completed OpenCode tool parts before each model
request. It normalizes `filePath`, `file_path`, or `path` against the worktree
and classifies an earlier Read as stale after a later write, or superseded only
when a later Read fully covers its offset/limit range. Fresh and partially
overlapping reads remain byte-exact.

The scan is bounded to 10,000 relevant operations. If that limit is exceeded,
the entire lifecycle pass fails open for the request; it never classifies or
rewrites a partial history. Marker paths are display-only and have Unicode
control and formatting characters removed before they enter model context.

The latest explicit cache-control marker freezes its complete message prefix;
no lifecycle replacement is allowed at or before it. Eligible originals enter
CCR before mutation, and the manager replays only bounded callID-to-hash/digest
state. A non-counting Store `peek` verifies that a cached hash remains live;
an evicted entry is committed again before its marker is emitted. Store or
classification failures are fail-open. The lifecycle pass runs before
prefix-monotonic span folding so a fresh latest Read remains available as the
model's source of truth.

### Canonical CCR commit

The engine never treats its preliminary content hash as committed. `CCRStore`
allocates the canonical key, including collision handling, and can ask the
engine to render marker-bearing compressed content for that final key. The
returned entry is the single source of truth for the hash, compressed content,
and compressed token count.

The reversibility invariant is:

> Every emitted marker identifies the exact original retained by CCR for the
> current session and the entry's remaining lifetime.

Each entry stores its selected retrieve default. This ensures a per-tool policy
continues to apply after restart when SQLite is used.

## Storage and lifecycle

`CCRStore` exposes `put`, counted session-scoped `get`, `deleteSession`,
`stats`, `pruneExpired`, and idempotent `close`. It optionally exposes a
non-counting session-scoped `peek`; both built-in adapters implement it so
internal lifecycle validation does not alter model retrieval statistics. Both
adapters share these semantics:

- TTL is checked before retrieval and statistics;
- capacity defaults to 10000 active entries;
- expired entries are pruned before oldest-first capacity eviction;
- hash collision history contains one digest registry entry per live key, never
  original content, and is bounded by active Store capacity;
- expiry, eviction, and session deletion remove orphan digest registry entries;
- a hash cannot be retrieved from another OpenCode session.

Normal strings retain the 0.1 SHA-256-prefix key. Lone-surrogate JavaScript
strings use a raw `0xff`-prefixed UTF-16LE hashing domain, which cannot collide
with valid UTF-8 bytes through an encoding-domain ambiguity. Store allocation
still disambiguates any active 96-bit key collision. Once an entry expires or
is evicted, its marker is outside the reversibility lifetime and the released
short key may be allocated again; cross-session lookup remains a miss.

`MemoryCCRStore` is process-local. `BunSQLiteCCRStore` persists exact CCR
entries. Storage diagnostics expose requested adapter, active adapter, and an
optional bounded fallback reason.

`auto` has one fallback condition: if Bun is unavailable, it selects memory and
records `unsupported_runtime`. When Bun exists, SQLite import, path, permission,
schema, and initialization failures are surfaced instead of silently changing
adapters.

### SQLite schema v2

The SQLite adapter uses `PRAGMA user_version = 2`, `secure_delete=ON`, the
configured busy timeout (5000 ms by default), `BEGIN IMMEDIATE` write
transactions, and best-effort `0600` file permissions.

Startup performs these ordered checks and migrations:

1. reject a database whose `user_version` is newer than 2;
2. create the entry table when absent;
3. add persisted retrieve-default mode and maximum-character columns to an old
   entry table;
4. migrate legacy hash history from original-content blobs to SHA-256 content
   digests and vacuum the rewritten database;
5. prune expired entries and enforce capacity;
6. backfill live digest history and set `user_version` to 2.

Active original content remains in `ccr_entries` because exact retrieval
requires it. The migration reduces duplicate retention in collision history; it
does not turn the database into non-sensitive metadata.

## Retrieval contract

Every entry has `CCRetrieveDefaults`. The standard default is bounded
`summary` with a 12000-character maximum. A matching compress rule may persist
`head`, `tail`, or `full` and a different maximum.

Request resolution is deterministic:

1. an explicit `mode` wins;
2. explicit line bounds select `range`;
3. non-empty query text selects `query`;
4. otherwise the entry's persisted default is used.

`query`, `range`, `head`, `tail`, and `summary` count headers and truncation
metadata inside the hard `maxChars` budget. Query matching is Unicode-aware and
NFKC-normalized. Partial retrieval of valid compact single-line JSON uses a
pretty, line-oriented view without changing the stored original. Explicit
`mode=full` without `maxChars` is the byte-exact recovery path.

The model-facing tool always supplies the current session ID. Invalid, expired,
evicted, deleted, and cross-session hashes produce a bounded miss rather than
content.

## Stats, telemetry, and debugging

CCR statistics describe currently active entries. The independent
`LocalTelemetryAggregator` records global and per-session operational totals:

- requested and active adapter plus fallback reason;
- compressed, skipped, and error outcomes with a sorted reason distribution;
- gross estimated savings;
- retrieve output tokens by mode, misses, and full-retrieve rate;
- latency count, total, and maximum;
- estimated net savings.

Net savings is not clamped:

```text
estimated net savings = gross estimated savings - all retrieve output tokens
```

Telemetry accepts only session identifiers, bounded enums, numeric counts, and
durations. It never retains original output, tool arguments, path content, or
query text. Telemetry failures are caught at integration boundaries and cannot
change hook or tool behavior.

Debugging is separate, disabled by default, and may expose tool, session, call,
path, routing, and selection metadata. Summary or trace records can be attached
to OpenCode metadata, appended to NDJSON, or both. Debug file failures remain
fail-open.

## Safety and privacy invariants

- A normal hook failure preserves the original displayed output.
- An existing CCR marker is not compressed again.
- Code, diff, table, HTML, JSON, search, log, mixed, and text candidates must
  pass their protected-fact, structure, and token-savings checks; otherwise the
  original output remains unchanged.
- File-backed output is read only through the trusted source boundary.
- Every emitted marker uses the store's committed canonical key.
- Read lifecycle never rewrites the explicit cache-controlled prefix and never
  emits a marker until its CCR entry is confirmed live.
- Read lifecycle leaves an over-limit operation history unchanged and removes
  control/formatting characters from display paths in its markers.
- Retrieval is scoped to the current session.
- TTL, capacity, session deletion, and store close are consistent across memory
  and SQLite adapters.
- No Headroom network request is initiated by the native engine.
- Telemetry is observational and cannot affect policy or compression output.
- Persistent CCR and debug artifacts are sensitive and remain untracked.

SQLite `secure_delete`, owner-only permissions, v2 digest history, TTL, and
deletion reduce exposure but do not erase backups, filesystem snapshots, or
copied side files. Immediate erasure requires removing the database and all
associated `-wal`, `-shm`, and `-journal` files from every copy.

## 0.1 to 0.2 compatibility

The 0.2 parser accepts 0.1 options, including `skipTools`, but changes several
defaults deliberately:

- custom skip lists should become ordered `toolPolicy` preserve rules;
- bare retrieval changes from full original to bounded summary;
- SQLite `auto` fallback changes from broad catch-all behavior to
  unsupported-runtime only;
- file-backed output is restricted to Bash inside the worktree unless expanded;
- CCR capacity is bounded at 10000 by default;
- SQLite data migrates to schema v2;
- OpenCode session deletion and plugin disposal now clean owned resources;
- stats include local retrieval cost and net-savings telemetry.

These are compatibility changes, not adaptive behavior. Every selected policy,
adapter, and retrieve default is explainable from configuration and fixed
resolution rules.

## Packaging and release contract

`prepack` removes and rebuilds `dist`. The npm artifact contains compiled
JavaScript and declarations, README, this design, example configuration,
license, and package metadata. Source, tests, benchmarks, internal plans, and
the upstream `headroom/` reference checkout are excluded.

The release gates are:

1. targeted and full tests;
2. TypeScript typecheck and clean build;
3. deterministic `bench:check`, which cannot rewrite the tracked report;
4. clean tarball surface and temporary-consumer install;
5. `npm ls --all` without self, invalid, or unmet dependencies;
6. a TypeScript consumer compiling the public 0.2 configuration surface;
7. Node imports plus observable `auto -> memory` unsupported-runtime stats;
8. Bun plugin initialization from the installed tarball;
9. npm-normalized package metadata, dist-only public export targets, packed
   export presence, and conflict-copy rejection;
10. fixed-seed performance coverage for cold/hot token counting, routing,
    Store put/get, ordinary non-repetition compression, bounded retrieval, the
    complete tool/message-transform hooks, SQLite worker-concurrent writes, and
    SQLite cold start.
11. before publication, load the freshly installed tarball through a real
    OpenCode host rather than repository source or a stale local `dist`.

`bench:perf` and the scheduled performance workflow print fixed-seed
10/100/250 KiB token-counter and memory/SQLite p50, p95, and max results. The P0
10 KiB memory-backed `tool.execute.after` and Read-lifecycle
`messages.transform` p95 values are blocking `< 50 ms` gates. Larger payload
and SQLite results remain non-blocking baselines until enough stable CI history
exists to approve regression thresholds.

The current 0.2 build was host-smoked with OpenCode 1.17.13 from a temporary
tarball installation: the host loaded the installed `dist/plugin.js` and
initialized the expected SQLite schema v2 without issuing a model request.

`bun.lock` is the canonical repository lockfile. Generated `dist`, `.headroom/`,
SQLite side files, debug traces, and local package artifacts remain untracked.

## Extension boundaries

New tool behavior belongs in `ToolPolicy`; new trusted file sources belong
behind the output-source interface; new compression strategies belong behind
the router/compressor profile; new persistence belongs behind `CCRStore`; and a
future Headroom WASM, HTTP, or CLI implementation belongs behind
`CompressionEngine`.

Any network-backed engine must be explicit and opt-in. It must not alter the
native no-proxy default, weaken local privacy guarantees, or consume telemetry
as an implicit policy-learning signal.
