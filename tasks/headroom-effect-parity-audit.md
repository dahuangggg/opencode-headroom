# Headroom Effect Parity Audit

Date: 2026-07-14

Branch: `codex/headroom-effect-parity`

Reference: `headroom-ai@0.31.0`, commit
`52a024d28cff7808659240b3f4c5ceb4fa11e0e8`, profile `coding`

## Verdict

All approved success criteria pass. The implementation reaches observable
effect parity across compression, retrieval, multi-turn context lifecycle,
context protection, and local resilience without adding provider interception,
a proxy, a runtime network call, or a large ML dependency.

## Information correctness and effect

- The default `coding` profile now matches the pinned Headroom activation
  thresholds (`25` estimated tokens or `25` characters). `legacy` restores the
  earlier plugin thresholds (`2000` / `8000`), and explicit thresholds remain
  authoritative.
- A live native-plugin check compressed the 1323-token search fixture to 157
  tokens under `coding`, while `legacy` preserved all 1323 tokens. A 240-token
  repeated log folded to 16 tokens under `coding` and remained unchanged under
  `legacy`.
- The coding pipeline applies runtime-verified reversible run folding for
  log/text and ripgrep heading folding for search before lossy selection. The
  lossy candidate is gated against the original payload; when it cannot improve
  safely, the reversible fold remains the compression floor. CCR `mode=full`
  returns the exact pre-fold input.

- `bun run bench:quality` passed all nine annotated kinds: JSON, search, log,
  text, code, diff, table, HTML, and explicit mixed output.
- Protected-fact and type-structure checks passed for every local fixture.
  Headroom table and mixed snapshots are explicitly marked structurally unsafe,
  so they do not require the local implementation to discard headers or mixed
  framing.
- Local output token counts by fixture were `218`, `872`, `121`, `1404`,
  `2772`, `1594`, `132`, `1396`, and `940` respectively.
- Aggregate savings parity was `179.5%` (`3602.272066705964 / 2007`), above
  the required `95%`; the blocking per-kind median and named-fixture checks
  passed.
- `bun run bench:check` passed 78 exact CCR round-trips across memory and
  Bun SQLite, 132 compressed/query protected-fact checks, six exact-code and
  six bounded-diff CCR round-trips, and 78 bounded non-negative default
  retrieves. Structured and overall estimated net savings were `95.7%` and
  `82.8%`.
- Existing-marker, fail-open, cross-session, expiry, deletion, eviction,
  collision, and hard `maxChars` behavior remain covered by the full suite.

## Multi-turn behavior and privacy

- Exact and at-least-90%-similar results fold only within one session and emit
  a bounded pointer with a canonical committed CCR hash.
- Coding-profile shell reads from `cat`, `head`, `tail`, `sed -n`, and supported
  wrappers now preserve source/plain-text bytes before per-output compression;
  structured data and generated lockfiles remain eligible.
- The native OpenCode message-transform hook performs Headroom-style contiguous
  span folding over completed tool outputs after their final per-block form is
  known. It supports constant line-number shifts, keeps the earliest occurrence
  in context, and is prefix-monotonic as turns are appended.
- `mode=full` returns the repeated call's exact bytes. A different session
  cannot match or retrieve the entry.
- Intent, repetition, telemetry, and CCR session state are bounded and cleared
  on their documented lifecycle. Repetition state retains signatures and line
  fingerprints, not raw tool output; telemetry/debug privacy tests pass.

## Local resilience

- A versioned compression-decision cache reuses deterministic positive results
  and stable metadata-only skip decisions across sessions after repetition
  matching. Its key covers full content and query digests plus every normalized
  compression-affecting option.
- Positive cache hits recommit the current exact original to the owning CCR
  session and rerender collision hashes when necessary. The unified cache is
  bounded to 512 entries, 2,000,000 result characters, 250,000 characters per
  result, and a non-sliding 30-minute lifetime.
- Three consecutive failures open only the affected strategy for 60 seconds.
  Open-circuit and other transient outcomes fail open byte-exact and never enter
  either decision-cache tier; a single half-open trial decides recovery.
- Session deletion clears only session-owned repetition state. Plugin disposal
  also clears reusable decisions and circuit-breaker state.

## Performance

- `bun run bench:perf` passed both blocking 10 KiB memory hook gates:
  `tool.execute.after p95=1.178 ms` and
  `messages.transform p95=0.355 ms`, each below `50 ms`.
- Token counting is reported separately: 10 KiB cold/hot p95 was
  `0.142/0.136 ms`; 250 KiB cold/hot p95 was `2.995/3.030 ms`.
- Ordinary in-memory compression p95 for 10/100/250 KiB was
  `1.550/5.783/12.519 ms`; a decision-cache hit reduced it to
  `0.163/1.358/2.744 ms`. The benchmark uses distinct sessions so this row
  measures cross-session decision reuse rather than repetition folding.
- SQLite concurrent-write and cold-start rows remain recorded baselines rather
  than blocking thresholds. No measured hook crossed the approved P0 budget.

## Build, package, and real host

- `bun test tests`: 367 passed, 0 failed, 1236 assertions.
- `bun run typecheck`, `bun run build`, `bun run lint:package`, and
  `bun run test:package` passed; `npm audit --omit=dev` found 0 vulnerabilities.
- Package smoke rebuilt from clean state, packed 91 files, installed the
  tarball into a temporary consumer, passed `npm ls --all`, compiled the public
  TypeScript API, and initialized Node and Bun imports.
- A second fresh tarball was installed into an isolated temporary consumer.
  OpenCode `1.17.13` loaded that installed `dist/plugin.js` through
  `opencode debug config` with isolated HOME/XDG directories and no model
  request. The plugin created `host-smoke.sqlite` with `user_version=2`, the
  required `ccr_entries` and `ccr_hash_history` tables, and file mode `600`.

## Review

The final five-axis review covered correctness, readability, architecture,
security, and performance. Adversarial review reproduced one required issue:
an open strategy inside mixed output could initially leave a stable-looking
top-level result that was eligible for caching. Mixed routing now propagates a
transient `cacheable=false` signal through both unchanged and partially changed
results, and a controllable-clock test proves recovery recompresses after the
60-second cooldown. Metadata validation was also tightened so cached token
counts cannot carry invalid runtime values. Collision expiry, Store rollback,
lone-surrogate digests, positive and negative mixed recovery, and exact CCR
retrieval were independently re-probed. No Critical or Required findings
remain.
