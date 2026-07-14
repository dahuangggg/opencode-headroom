# Spec: Headroom Effect Parity

Status: approved for implementation
Date: 2026-07-14
Reference: `headroom-ai@0.31.0`, repository commit
`52a024d28cff7808659240b3f4c5ceb4fa11e0e8`, coding profile

## Objective

Make the native OpenCode plugin deliver materially the same tool-output
compression effect as the pinned Headroom reference without adopting its proxy
architecture. Effect parity means comparable information retention, token
savings, type-aware behavior, and exact CCR recovery on the same inputs.

The plugin remains native to OpenCode and continues to operate through
`tool.execute.after`. Existing advantages are requirements, not optional
compatibility: session-scoped CCR, trusted recovery of OpenCode output files,
bounded partial retrieval, local-only telemetry, and fail-open hook behavior.

Exact output-string equality is not a goal. The quality oracle is the observable
result on a fixed, annotated corpus.

## Assumptions

1. The pinned Headroom coding profile is the comparison target even when newer
   upstream commits appear during implementation.
2. Deterministic native compression is preferred. A large ML runtime is added
   only if the deterministic implementation cannot meet the quality gate and
   only after explicit approval.
3. Provider transport, cache-control headers, proxy routing, provider billing,
   and dashboard behavior are outside the product boundary.
4. New behavior may deepen private compressor logic without exposing row
   counts, weights, or strategy selection through the public configuration.
5. Existing public 0.2 configuration remains accepted unless a separately
   documented migration is approved.

## Tech Stack

- TypeScript ESM compiled by `tsc`
- Bun and Node.js supported by the existing package contract
- Vitest for unit and integration tests
- Bun SQLite for the persistent CCR adapter
- Pinned local Headroom checkout used only by the development parity oracle

No runtime network call is permitted in the compression hook.

## Commands

```text
Targeted test:  bun test tests/<name>.test.ts
Full tests:     bun test tests
Typecheck:      bun run typecheck
Build:          bun run build
Quality gate:   bun run bench:quality
Baseline gate:  bun run bench:check
Performance:    bun run bench:perf
Package lint:   bun run lint:package
Package smoke:  bun run test:package
```

`bench:quality` is introduced by this work and must run deterministically from
the repository. Live Headroom oracle refresh is a separate explicit command so
ordinary tests do not depend on Python, the reference checkout, or the network.

## Project Structure

```text
src/token.ts                  token counter contract and safe fallback
src/engine/                   orchestration, retrieval, and content routing
src/compressors/              type-specific deterministic compressors
src/session/                  bounded session intent and repetition state
benchmarks/parity/            annotated corpus, oracle snapshots, comparison
tests/                        behavioral and integration tests
tasks/                        approved spec, plan, and implementation checklist
```

## Code Style

Keep boundaries explicit and behavior deterministic. Public configuration is
normalized once; hot-path functions consume small internal types.

```ts
const candidateTokens = tokenCounter.count(candidate, context.model);
if (candidateTokens >= originalTokens) {
  return unchanged(original, "no_token_savings");
}
return changed(candidate, candidateTokens);
```

- Prefer pure functions for detection, scoring, and selection.
- Preserve original ordering after selecting content.
- Keep fail-open behavior at integration boundaries.
- Do not hide initialization failures with broad fallback catches.

## Features

### F1. Executable parity oracle

- Maintain a fixed annotated corpus covering JSON, search, logs, text, code,
  diffs, mixed output, tabular data, and HTML.
- Store a versioned oracle snapshot generated from the pinned Headroom target.
- Compare local output tokens, protected-fact recall, structural invariants,
  strategy decisions, and latency.
- A separate refresh command must prove the snapshot came from the pinned
  checkout and record its commit and profile.

### F2. Model-aware token accounting

- Replace `characters / 4` as the acceptance gate with a token-counter
  interface.
- Use a model-specific tokenizer when one is available locally.
- Use a deterministic fallback calibrated separately for ASCII prose, CJK,
  source code, and high-entropy text.
- Never accept a candidate unless the selected counter reports fewer tokens.

### F3. Session intent and relevance

- Maintain the latest bounded user intent per OpenCode session when the host
  surface provides it.
- Build compressor relevance from session intent plus scalar tool arguments.
- Do not write raw intent, arguments, or queries to telemetry or debug files.
- Remove intent state on `session.deleted` and on plugin disposal.

### F4. Multi-stage compression pipeline

- Run safety and marker checks first.
- Detect envelopes and explicit mixed sections without changing stored bytes.
- Apply a lossless type-native fold before lossy selection when available.
- Run the type-specific compressor, then a safe fallback only when needed.
- Accept only candidates that pass protected-fact, structure, and token gates.

### F5. Type coverage

- Preserve and improve the existing JSON, search, log, and extractive-text
  behavior.
- Add code-aware compression that preserves imports, declarations, signatures,
  types, error-adjacent lines, and query-relevant symbols.
- Add diff compression that preserves file headers, hunk headers, and changed
  lines while folding unchanged context.
- Add tabular compression that preserves headers, abnormal rows, first/last
  samples, query-relevant rows, and an omission summary.
- Add HTML extraction that preserves title, main text, links, tables, and error
  content while dropping scripts, styles, and navigation noise.
- Support those strategies inside explicit mixed-output sections.

### F6. Cross-turn repetition folding

- Detect repeated or highly similar tool output inside one session.
- Emit a bounded pointer summary for repeated content while retaining exact CCR
  recovery.
- Never retrieve or fold content across sessions.
- Bound and delete repetition state with the same lifecycle as session state.

### F7. CCR and retrieval invariants

- Every emitted marker resolves to the committed entry for its session and
  lifetime.
- `mode=full` remains byte-exact.
- `query`, `range`, `head`, `tail`, and `summary` remain bounded and are never
  weakened to upstream's full-only behavior.
- All new strategies use the canonical Store commit path.

## Testing Strategy

- Small tests cover token counting, detection, protected facts, selection,
  compressors, and repetition matching.
- Medium tests cover plugin/session state, Store adapters, mixed routing, and
  installed package behavior.
- The parity corpus is a deterministic quality test, not a network test.
- Live oracle refresh is run when the pinned baseline changes and is reviewed
  as data.
- Existing performance and package gates remain blocking.

Every behavior change follows red-green-refactor. A new test must fail for the
intended reason before production code is added.

## Boundaries

### Always

- Preserve exact originals before emitting lossy output.
- Keep normal hook failures fail-open.
- Run the targeted test for each increment and the full suite at checkpoints.
- Preserve unrelated worktree changes and keep commits atomic.
- Report actual verification commands and results.

### Ask first

- Add a large ML model or a runtime dependency with material install cost.
- Change the public configuration incompatibly.
- Change CI, publish a package, create a release, or push remote changes.
- Lower an approved quality or performance threshold.

### Never

- Add provider transport interception or a Headroom proxy requirement.
- Send tool output, user intent, or retrieval queries to a remote service.
- claim parity from aggregate token savings alone.
- skip, weaken, or delete a failing regression to make a gate pass.

## Success Criteria

### Information correctness

- Protected-fact recall is 100% for annotated errors, warnings, paths and line
  numbers, stack frames, identifiers, JSON priority rows, code signatures and
  types, and diff file/hunk/changed lines.
- Structured outputs pass their type-specific validity checks.
- Existing markers are never compressed again.
- Any internal failure preserves the original displayed output.

### Effect parity

- Per content type, median local output tokens are no more than 110% of the
  pinned Headroom result on fixtures both systems safely compress.
- Total local token savings are at least 95% of pinned Headroom savings.
- A smaller output is accepted only when protected-fact recall remains 100%.
- Every failing fixture is named in the quality report; averages cannot hide a
  regression.

### CCR

- 100% of emitted markers retrieve the exact original with `mode=full` in the
  owning session.
- Cross-session, expired, deleted, evicted, and invalid retrievals are bounded
  misses.
- Partial modes obey the complete `maxChars` budget.

### Performance and delivery

- The existing 10 KiB memory-backed hook gate remains p95 < 50 ms.
- Fixed non-P0 fixtures have no unexplained regression greater than 20% from
  the recorded pre-change baseline.
- Tokenizer cold start and hot path are reported separately.
- Full tests, typecheck, build, parity quality, baseline, performance, package
  lint, package smoke, clean-tarball install, and real OpenCode host smoke pass.
- No test is skipped and no required artifact is left untracked.

## Open Questions

None blocking implementation. ML remains an approval-gated contingency rather
than part of the initial design.
