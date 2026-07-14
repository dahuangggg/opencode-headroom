# Headroom Multi-turn Context Lifecycle Baseline

Date: 2026-07-14

## Reference split

Single tool-output quality remains pinned to `headroom-ai@0.31.0`, commit
`52a024d28cff7808659240b3f4c5ceb4fa11e0e8`, profile `coding`, as defined by
`headroom-effect-parity-spec.md`. Its oracle is not refreshed by this work.

Multi-turn lifecycle behavior is audited separately against the current local
`headroom/` checkout:

- commit: `88f935a1eb52ec81cdd60db44627279d411b74ab`
- describe: `v0.30.0-13-g88f935a1`
- commit date: `2026-07-05T16:00:25-07:00`

This split prevents a lifecycle change from silently redefining the completed
compression-quality benchmark.

## Upstream default behavior

The local Headroom reference currently defines:

- Prefix freeze enabled, minimum cached prefix 1024 tokens, session TTL 600
  seconds, and force-compress threshold 0.5.
- Read lifecycle enabled with stale compression enabled, superseded compression
  disabled, and a 512-byte minimum payload.
- Read maturation disabled with 5 quiescent turns, 25 maximum hold turns, and a
  2048-byte minimum payload.
- Net-cost mutation policy is opt-in through `HEADROOM_NET_COST_POLICY=1`.

The current implementation and tests also establish these lifecycle invariants:

1. A leading provider-cached prefix is not modified by Read lifecycle.
2. At least the trailing message remains in the live zone.
3. A stale or superseded Read inside the frozen prefix is classified but left
   byte-exact.
4. Net-cost mutation of a frozen slot is an explicit opt-in exception, not the
   default path.

Authoritative local sources:

- `headroom/headroom/config.py`
- `headroom/headroom/transforms/read_lifecycle.py`
- `headroom/headroom/cache/compression_cache.py`
- `headroom/tests/test_compression_cache.py`
- `headroom/tests/test_netcost_gate.py`

## Native OpenCode translation

OpenCode's `experimental.chat.messages.transform` exposes messages and stable
message/session identifiers, but provider cache breakpoints may be applied
after this hook. The native plugin therefore uses a conservative observable
frontier instead of pretending to know the provider's exact cache state:

- The first observation of a session seeds the frontier and changes nothing.
- On later transforms, previously observed message identities are frozen.
- Previously unseen messages form the live zone for that invocation.
- Explicit `cache_control` metadata can only expand the frozen region.
- Missing or malformed identity information is frozen, never guessed mutable.
- Frozen history remains available as a deduplication reference but cannot be a
  mutation target.

This is intentionally stricter than a proxy with provider-response telemetry.
It preserves the user-visible cache effect while staying within the native
OpenCode plugin boundary.
