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
