# Changelog

All notable changes to this project are documented in this file.

## [0.3.0] - 2026-07-14

### Added

- Headroom-compatible `coding` profile with calibrated activation thresholds,
  protected-fact validation, and relevance from bounded session intent.
- Syntax-aware compression for Python, TypeScript, and JavaScript, plus bounded
  compression for diffs, tables, HTML, JSON, search output, logs, and text.
- Cache-safe multi-turn context handling, stale-Read lifecycle processing,
  reversible compaction, and exact CCR recovery across supported stores.
- Adaptive information-aware selection, repeated-span folding, bounded
  cross-session decision reuse, and per-strategy fail-open circuit breaking.

### Changed

- The default native OpenCode behavior now follows the reviewed Headroom coding
  profile while keeping the previous thresholds available through `legacy`.
- Retrieval defaults are bounded, while explicit `mode=full` still returns the
  exact original content.

### Fixed

- Preserved active source reads, short strong errors, security-relevant changes,
  rare rows, numeric outliers, and mixed-output framing during compression.
- Prevented transient failures, open circuits, Store rollbacks, and mixed-section
  partial results from poisoning reusable decisions or emitting invalid markers.

## [0.2.0] - 2026-07-12

### Added

- Initial public release of the native OpenCode tool-output compression plugin,
  CCR retrieval tools, memory and Bun SQLite stores, and local telemetry.
