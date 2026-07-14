# Implementation Plan: Headroom Effect Parity

## Overview

Implement the approved effect-parity spec in risk-first, independently
verifiable slices. The pinned oracle and token counter land before compressor
expansion so every later change is measured against the same quality contract.

## Architecture Decisions

- Keep `tool.execute.after` and the existing `CompressionEngine`/`CCRStore`
  boundaries.
- Treat the annotated parity corpus and pinned oracle snapshot as the quality
  contract; live Headroom execution only refreshes that snapshot.
- Add context and repetition as bounded session-scoped state owned by the
  plugin lifecycle.
- Preserve deterministic native defaults; ML remains approval-gated.
- Keep the public policy intent-level while compressor budgets stay private.

## Dependency Graph

```text
Pinned corpus + oracle metadata
  -> executable quality gate
      -> token-counter contract
          -> session relevance
              -> multi-stage pipeline
                  -> code/diff/tabular/HTML compressors
                      -> cross-turn folding
                          -> final host/package/performance audit
```

## Phase 1: Measurement Foundation

### Task 1: Pin the corpus and oracle contract

Create annotated fixtures, oracle schema, snapshot validation, and an explicit
Headroom refresh adapter.

Acceptance:
- The snapshot records exact upstream commit, profile, fixture identity, output
  tokens, and protected facts.
- A stale, incomplete, or mismatched snapshot fails loudly.
- Ordinary tests require no network or Python runtime.

Verify:
- `bun test tests/parity-oracle.test.ts`
- `bun run typecheck`

Likely files:
- `benchmarks/parity/types.ts`
- `benchmarks/parity/fixtures.ts`
- `benchmarks/parity/oracle.ts`
- `benchmarks/parity/oracle.json`
- `tests/parity-oracle.test.ts`

### Task 2: Add the blocking quality report

Execute the local engine against the corpus and enforce fact recall, structural
validity, per-kind median, and aggregate savings thresholds.

Acceptance:
- The gate names each failing fixture and metric.
- The package exposes `bench:quality`.
- A deliberately corrupted result makes the test and command fail.

Verify:
- `bun test tests/quality-gate.test.ts`
- `bun run bench:quality`

Likely files:
- `benchmarks/quality-gate.ts`
- `benchmarks/parity/compare.ts`
- `tests/quality-gate.test.ts`
- `package.json`

### Checkpoint 1

- Full existing tests pass.
- Typecheck and build pass.
- The quality gate runs deterministically and honestly reports current gaps.

## Phase 2: Correct Decisions

### Task 3: Replace the fixed token estimator

Introduce a token-counter contract with model-aware local implementations and
a calibrated deterministic fallback.

Acceptance:
- CJK, code, prose, and high-entropy fixtures no longer share one chars/token
  ratio.
- Compression acceptance and telemetry use the same counter result.
- No hot-path network access or large model load occurs.

Verify:
- `bun test tests/token-counter.test.ts tests/native-engine.test.ts`
- `bun run bench:perf`

Likely files:
- `src/token.ts`
- `src/engine/types.ts`
- `src/engine/native.ts`
- `tests/token-counter.test.ts`

### Task 4: Add bounded session intent

Capture the latest host-provided user intent and combine it with safe scalar tool
arguments for compressor relevance.

Acceptance:
- Relevant content selected by user intent survives when tool arguments alone
  would not select it.
- Intent never appears in telemetry/debug serialization.
- Session deletion/disposal removes all state.

Verify:
- `bun test tests/session-intent.test.ts tests/plugin.test.ts`

Likely files:
- `src/session/intent.ts`
- `src/plugin.ts`
- `src/engine/types.ts`
- `src/engine/native.ts`
- `tests/session-intent.test.ts`

### Checkpoint 2

- Full tests, typecheck, build, quality, and P0 performance gate pass.
- Quality report shows the decision-layer delta separately from new types.

## Phase 3: Compression Coverage

### Task 5: Introduce the multi-stage candidate gate

Separate detection, lossless folding, strategy candidates, protected-fact
validation, and token acceptance without changing public behavior.

Acceptance:
- Candidate rejection always returns the exact original.
- Marker and Store commit happen only after final acceptance.
- Existing JSON/search/log/text fixtures remain behaviorally compatible.

Verify:
- `bun test tests/pipeline.test.ts tests/router.test.ts tests/native-engine.test.ts`

Likely files:
- `src/engine/pipeline.ts`
- `src/engine/router.ts`
- `src/engine/native.ts`
- `src/compressors/types.ts`
- `tests/pipeline.test.ts`

### Task 6: Add code-aware compression

Acceptance:
- Imports, declarations, signatures, types, protected facts, and relevant
  symbols are preserved exactly and in order.
- Low-relevance implementation folds only when token savings are positive.
- Unsupported or ambiguous code remains unchanged.

Verify:
- `bun test tests/code-compressor.test.ts tests/router.test.ts`

Likely files:
- `src/compressors/code.ts`
- `src/engine/router.ts`
- `src/compressors/profile.ts`
- `tests/code-compressor.test.ts`

### Task 7: Add diff compression

Acceptance:
- File headers, hunk headers, additions, and deletions are preserved exactly.
- Only unchanged context can be folded.
- Malformed and already-small diffs remain unchanged.

Verify:
- `bun test tests/diff-compressor.test.ts tests/router.test.ts`

Likely files:
- `src/compressors/diff.ts`
- `src/engine/router.ts`
- `src/compressors/profile.ts`
- `tests/diff-compressor.test.ts`

### Task 8: Add tabular and HTML compression

Acceptance:
- Tabular headers and annotated abnormal/relevant rows survive.
- HTML scripts/styles/navigation are removed while title, main content, links,
  tables, and protected facts survive.
- Mixed sections retain exact framing and original order.

Verify:
- `bun test tests/tabular-compressor.test.ts tests/html-compressor.test.ts tests/router.test.ts`

Likely files:
- `src/compressors/tabular.ts`
- `src/compressors/html.ts`
- `src/engine/router.ts`
- `tests/tabular-compressor.test.ts`
- `tests/html-compressor.test.ts`

### Checkpoint 3

- Full tests, quality, typecheck, build, and performance gates pass.
- Every content type meets its protected-fact gate.

## Phase 4: Multi-turn Behavior and Delivery

### Task 9: Add session-scoped repetition folding

Acceptance:
- Repeated content emits a bounded pointer summary and a valid CCR marker.
- Similarity cannot cross session boundaries.
- Capacity, session deletion, and disposal bound all retained state.

Verify:
- `bun test tests/repetition.test.ts tests/plugin.test.ts tests/ccr-invariants.test.ts`

Likely files:
- `src/session/repetition.ts`
- `src/plugin.ts`
- `src/engine/types.ts`
- `tests/repetition.test.ts`

### Task 10: Complete the release-grade audit

Acceptance:
- All spec success criteria have direct current-state evidence.
- Installed tarball and real OpenCode host smoke use the built artifact.
- No unrelated or generated files are staged.

Verify:
- all commands in the spec
- clean consumer install/import
- real OpenCode host smoke without a model request

Likely files:
- `README.md`
- `DESIGN.md`
- `scripts/package-smoke.mjs`
- parity reports only when intentionally updated

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Headroom Python/Rust behavior differs | High | Pin commit, profile, adapter, and snapshot provenance |
| Tokenizer dependency harms startup | High | Contract first; local lazy implementation; measure cold/hot paths |
| Code/diff compression loses semantics | High | Protected-fact gate and conservative passthrough defaults |
| Average savings hides bad fixtures | High | Per-fixture failures plus per-kind medians and aggregate threshold |
| Session state leaks content | High | Bounded state, lifecycle deletion, no telemetry serialization |
| Large change becomes unreviewable | Medium | One vertical task per tested atomic commit |

## Open Questions

None blocking. ML and public breaking changes remain approval-gated.

## Extension: Multi-turn Context Effect Parity

The completed plan above remains the contract for single tool-output effect
parity. This extension aligns the default multi-turn cache and context behavior
without adopting Headroom's proxy transport.

### Phase 0: Lock the lifecycle reference

- Keep the existing pinned compression oracle unchanged.
- Record the separate Headroom lifecycle reference and its default flags.
- Translate provider-visible cache semantics into conservative native-hook
  invariants before changing runtime behavior.

Verify:
- `tasks/headroom-context-lifecycle-baseline.md` names the exact references.
- Every claimed default points to current local Headroom source or tests.

### Phase 1: Add cache-aware Context Lifecycle

- Track a bounded, session-scoped frontier of completed part identities already
  seen by the transform hook.
- Treat the first observation of a session as frozen history and only permit
  later, previously unseen completed parts to enter the mutable live zone.
- Replay the exact changed representation sent on an earlier request when
  OpenCode reloads the part's raw stored output.
- Preflight replayed Read markers and restore raw output when exact CCR backing
  is no longer active.
- Apply the same live-zone boundary to Read lifecycle and span deduplication.

Acceptance:
- Previously observed messages remain byte-exact when later turns are appended.
- A newly appended tool result can still be compressed against frozen history.
- A previously transformed live part replays the same sent bytes; a Read marker
  does so only while its exact CCR backing remains active, otherwise raw is
  restored.
- Unknown identities, overflow, and storage failures fail open conservatively.
- Session deletion and plugin disposal clear all lifecycle state.
- Same-session transforms, cleanup, and disposal cannot race asynchronous
  lifecycle writes; active queues are bounded.

Verify:
- `bun test tests/context-lifecycle.test.ts tests/read-lifecycle.test.ts tests/multiturn-parity.test.ts tests/plugin.test.ts`
- `bun run typecheck && bun run build`

### Phase 2: Align Read lifecycle defaults

- Compress stale Reads, preserve superseded Reads by default, and skip Read
  payloads smaller than 512 bytes.
- Keep `readLifecycle?: boolean` backward compatible; advanced internal policy
  must not become a required public configuration migration.

Acceptance:
- Stale live-zone Reads retain exact CCR recovery.
- Superseded and sub-512-byte Reads remain byte-exact by default.
- Frozen stale Reads are classified but never rewritten.

### Phase 3: Add net-cost mutation decisions

- Compare token savings with cache invalidation and future cache-read cost.
- Keep the default conservative when provider cache state is not observable.
- Never use runtime network calls or provider transport interception.

### Phase 4: Add relevance split and context protection

- Combine bounded session intent, scalar tool arguments, active file, errors,
  and recent Python/TS/JS code when selecting content.
- Preserve system/user content and the frozen prefix exactly.

### Phase 5: Add decision caches and circuit breaking

- Cache bounded compression and skip decisions without retaining unbounded raw
  content.
- Fail open and temporarily bypass a strategy after repeated local failures.
- Finish with all quality, CCR, performance, build, and package gates.

## Extension Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| OpenCode adds provider cache markers after the plugin hook | High | Freeze previously observed message identities even when metadata is absent |
| First transform occurs after a plugin restart with old history | High | Seed state without mutating anything on first observation |
| Cache safety removes existing historical dedup savings | Medium | Keep frozen history as references and compress only newly appended live outputs |
| Public configuration behavior changes accidentally | Medium | Preserve the existing boolean surface and add only optional fields if later required |
