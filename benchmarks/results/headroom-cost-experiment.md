# Headroom Cache/Cost Experiment

Generated: 2026-07-06T07:45:08.229Z

## Assumptions

- Future cache-read turns per output: 3
- Stable system/tools/history prefix is excluded from deltas because the native plugin only compresses live tool output.
- Uncached input price: $3.000000 / 1M tokens
- Cache read price: $0.300000 / 1M tokens
- Cache write price reference: $3.750000 / 1M tokens
- OpenCode display cap model: first 51264 chars of a large retrieve result.

## Compression Results

| Fixture | Kind | Strategy | Original tokens | Compressed tokens | Saved | Reduction | Hash |
|---|---:|---:|---:|---:|---:|---:|---|
| json_rows | json | json | 27917 | 1658 | 26259 | 94.1% | 3d619c038f9b14eafd71a13f |
| search_results | search | search | 4323 | 470 | 3853 | 89.1% | ea1c7dc9fef83ddebf69528e |
| pytest_log | log | log | 19359 | 2471 | 16888 | 87.2% | eeac649b5ca170bdee63c06b |
| plain_report | text | text | 7754 | 4831 | 2923 | 37.7% | 0328ff95db2d9c9a384ecfa2 |

## Cache-Adjusted Cost Scenarios

| Fixture | Scenario | Cost | Delta vs no Headroom | Savings |
|---|---:|---:|---:|---:|
| json_rows | headroom_no_retrieve | $0.006466 | $0.102410 | 94.1% |
| json_rows | current_full_retrieve_raw | $0.115343 | $-0.006466 | -5.9% |
| json_rows | current_full_retrieve_opencode_cap | $0.056449 | $0.052428 | 48.2% |
| json_rows | candidate_targeted_retrieve | $0.008525 | $0.100351 | 92.2% |
| search_results | headroom_no_retrieve | $0.001833 | $0.015027 | 89.1% |
| search_results | current_full_retrieve_raw | $0.018693 | $-0.001833 | -10.9% |
| search_results | current_full_retrieve_opencode_cap | $0.018693 | $-0.001833 | -10.9% |
| search_results | candidate_targeted_retrieve | $0.003487 | $0.013373 | 79.3% |
| pytest_log | headroom_no_retrieve | $0.009637 | $0.065863 | 87.2% |
| pytest_log | current_full_retrieve_raw | $0.085137 | $-0.009637 | -12.8% |
| pytest_log | current_full_retrieve_opencode_cap | $0.059619 | $0.015881 | 21.0% |
| pytest_log | candidate_targeted_retrieve | $0.012535 | $0.062966 | 83.4% |
| plain_report | headroom_no_retrieve | $0.018841 | $0.011400 | 37.7% |
| plain_report | current_full_retrieve_raw | $0.049082 | $-0.018841 | -62.3% |
| plain_report | current_full_retrieve_opencode_cap | $0.049082 | $-0.018841 | -62.3% |
| plain_report | candidate_targeted_retrieve | $0.022710 | $0.007531 | 24.9% |

## Retrieve Break-Even

| Fixture | Full raw retrieve break-even | OpenCode-capped full retrieve break-even | Targeted retrieve tokens | Full retrieve tokens |
|---|---:|---:|---:|---:|
| json_rows | 94.1% | 100.0% | 528 | 27917 |
| search_results | 89.1% | 89.1% | 424 | 4323 |
| pytest_log | 87.2% | 100.0% | 743 | 19359 |
| plain_report | 37.7% | 37.7% | 992 | 7754 |

## Interpretation

- The native plugin is cache-safe when it only rewrites the newest tool output: it does not mutate the provider cache hot zone.
- Full retrieve can erase savings because the original content re-enters the live zone and later becomes cached history.
- Targeted retrieve is the likely improvement lever: keep CCR reversible, but retrieve only query/range/head/tail slices unless exact full content is explicitly required.
