# Headroom Effect Parity Audit

Date: 2026-07-14

Branch: `codex/headroom-effect-parity`

Reference: `headroom-ai@0.31.0`, commit
`52a024d28cff7808659240b3f4c5ceb4fa11e0e8`, profile `coding`

## Verdict

All approved success criteria pass. The implementation reaches observable
effect parity without adding provider interception, a proxy, a runtime network
call, or a large ML dependency.

## Information correctness and effect

- `bun run bench:quality` passed all nine annotated kinds: JSON, search, log,
  text, code, diff, table, HTML, and explicit mixed output.
- Protected-fact and type-structure checks passed for every local fixture.
  Headroom table and mixed snapshots are explicitly marked structurally unsafe,
  so they do not require the local implementation to discard headers or mixed
  framing.
- Local output token counts by fixture were `436`, `872`, `121`, `1404`,
  `2007`, `4824`, `172`, `1396`, and `84` respectively.
- Aggregate savings parity was `117.4%` (`2356.6420542630813 / 2007`), above
  the required `95%`; the blocking per-kind median and named-fixture checks
  passed.
- `bun run bench:check` passed 78 exact CCR round-trips across memory and
  Bun SQLite, 132 compressed/query protected-fact checks, six exact-code and
  six exact-diff passthrough cases, and 78 bounded default retrieves. Structured
  and overall estimated net savings were `95.5%` and `82.6%`.
- Existing-marker, fail-open, cross-session, expiry, deletion, eviction,
  collision, and hard `maxChars` behavior remain covered by the full suite.

## Multi-turn behavior and privacy

- Exact and at-least-90%-similar results fold only within one session and emit
  a bounded pointer with a canonical committed CCR hash.
- `mode=full` returns the repeated call's exact bytes. A different session
  cannot match or retrieve the entry.
- Intent, repetition, telemetry, and CCR session state are bounded and cleared
  on their documented lifecycle. Repetition state retains signatures and line
  fingerprints, not raw tool output; telemetry/debug privacy tests pass.

## Performance

- `bun run bench:perf` passed the blocking 10 KiB memory hook gate at
  `p95=0.689 ms`, below `50 ms`.
- Token counting is reported separately: 10 KiB cold/hot p95 was
  `0.136/0.149 ms`; 250 KiB cold/hot p95 was `3.050/2.974 ms`.
- A same-machine detached `v0.2.0` comparison was run three times. Median
  pre-change memory hook p95 values were approximately `0.427/2.766/6.003 ms`
  for 10/100/250 KiB; the final run measured
  `0.689/5.167/12.587 ms`. The greater-than-20% difference is explained by the
  required calibrated full-content token scan, protected-fact/structure gate,
  and bounded repetition fingerprinting. Duplicate token scans and mislabeled
  Store-input preparation were removed during review; no unexplained regression
  remains, and all absolute measurements stay below the approved P0 budget.

## Build, package, and real host

- `bun test tests`: 192 passed, 0 failed, 0 skipped.
- `bun run typecheck`, `bun run build`, `bun run lint:package`, and
  `bun run test:package` passed.
- Package smoke rebuilt from clean state, packed 69 files, installed the
  tarball into a temporary consumer, passed `npm ls --all`, compiled the public
  TypeScript API, and initialized Node and Bun imports.
- A second fresh tarball was installed into an isolated temporary consumer.
  OpenCode `1.17.13` loaded that installed `dist/plugin.js` through
  `opencode debug config` with isolated HOME/XDG directories and no model
  request. The plugin created `host-smoke.sqlite` with `user_version=2` and
  tables `ccr_entries`, `ccr_hash_history`, and `sqlite_sequence`.

## Review

The final five-axis review covered correctness, readability, architecture,
security, and performance. One required issue was found and fixed: a trusted
pre-counted token value briefly entered the public engine input type. It now
crosses only the concrete native-plugin boundary, so external engine callers
cannot spoof the acceptance count. No Critical or Required findings remain.
