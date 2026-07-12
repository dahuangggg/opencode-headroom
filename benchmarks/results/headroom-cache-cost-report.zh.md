# OpenCode 原生 Headroom 插件 Cache/Cost 实验报告

日期：2026-07-06

0.2.0 契约更新：2026-07-12

## 1. 背景和问题

这个实验的核心问题是：OpenCode 本身已经会把超长 tool output 截断并落盘，那么原生 Headroom 插件是否仍然有价值？如果有，它和 provider cache 之间如何平衡，最终成本收益是否划算？

结论先说清楚：

- 原生插件仍然有价值，但价值不在于“替 OpenCode 存全文”。OpenCode 的截断只是避免界面和单次上下文爆炸，不能做类型感知摘要，也不能主动把有用结构留给模型。
- Headroom 插件的价值在于：在 tool output 进入模型上下文前，把大输出压缩成“可读摘要 + CCR hash + 可按需检索”的结构。
- 和 provider cache 的平衡点是：只压缩最新 live tool output，不改 system/tools/旧消息这些 cache hot prefix；同时 retrieve 时避免默认把全文重新塞回上下文。
- 当前实验显示：无 retrieve 时 JSON/search/log 可节省 87% 到 94% 输入 token；但如果一次 full retrieve，把原文又放回上下文，收益可能变成负数。
- 改进后的 `headroom_retrieve` 支持 query/range/head/tail/summary 局部检索，能保留 CCR 可逆性，同时避免 full retrieve 吃掉压缩收益。

## 2. Headroom 的 cache 思路

参考本地 `headroom/` 代码和文档，Headroom 的设计不是简单“看到长上下文就压缩”，而是区分 cache hot zone 和 live zone。

### 2.1 cache hot zone

cache hot zone 指 provider 更容易命中 prefix cache 的稳定前缀，通常包括：

- system prompt
- tool definitions
- 已经稳定下来的旧历史消息
- 被 prefix freeze 保护的早期 conversation prefix

这部分如果被频繁重写，会破坏 provider 的 prefix cache。对于有 cache read/write 计费差异的模型，破坏 cache 可能比节省少量 token 更贵。

### 2.2 live zone

live zone 是最近的、还没有稳定进入 cache hot prefix 的内容，例如刚执行完的 tool output。

原生 OpenCode 插件放在 `tool.execute.after`，正好只处理最新 tool output。这符合 Headroom 的方向：压缩 live zone，尽量不碰 cache hot zone。

### 2.3 Headroom 为什么不只是截断

OpenCode 的大输出截断是通用安全机制，通常表现为：

- 给模型一个前缀片段
- 告诉模型完整输出已经落盘
- 模型需要时再读取文件

这解决“不要一次塞爆上下文”的问题，但没有解决“模型应该看到什么信息”的问题。Headroom 型插件应当在截断前后做更有语义的处理：

- JSON：保留 schema、关键字段、异常行、代表性样本
- grep/search：保留 file:line、命中文本、文件分布
- log：保留 ERROR/FATAL、traceback、level 统计
- text：保留首尾、关键段、路径/行号/字段名

因此插件的目标不是替代 OpenCode 截断，而是把无结构的大输出变成模型更容易用的小上下文。

## 3. 本次实验设计

实验脚本：

```bash
bun run bench:check   # 只检查，不改写报告
bun run bench:report  # 显式重新生成成本报告
```

脚本位置：

```text
benchmarks/headroom-cost-experiment.ts
```

报告输出：

```text
benchmarks/results/headroom-cost-experiment.md
```

### 3.1 数据集

实验构造了 4 类典型 tool output：

| Fixture | 类型 | 目的 |
|---|---|---|
| `json_rows` | 大 JSON 数组 | 验证结构化数据压缩效果 |
| `search_results` | grep/rg 输出 | 验证 file:line 不丢失 |
| `pytest_log` | 日志/traceback | 验证错误级别和 traceback 保留 |
| `plain_report` | 普通长文本 | 验证兜底 text compressor 效果 |

这些数据模拟了真实 OpenCode 场景里的高频大输出：`cat` 大文件、`rg` 结果、测试日志、分析报告。

### 3.2 成本模型

实验用 token 估算方式 `chars / 4`，并建模以下场景：

- `headroom_no_retrieve`：压缩后不 retrieve
- `explicit_full_retrieve_raw`：显式 `mode=full` retrieve 完整原文
- `explicit_full_retrieve_opencode_cap`：显式完整 retrieve 后被 OpenCode 显示 cap 截断
- `candidate_targeted_retrieve`：使用 query/range 等局部 retrieve

计费假设：

| 项目 | 假设 |
|:-:|:--:|
| uncached input | $3.00 / 1M tokens |
| cache read | $0.30 / 1M tokens |
| cache write reference | $3.75 / 1M tokens |
| 后续 cache-read turn | 3 次 |
| OpenCode 大输出显示 cap | 51264 chars |

这些数字不是要精确模拟某个 provider 的账单，而是用来评估趋势：压缩收益会不会被 retrieve 和后续历史 cache 读成本抵消。

## 4. 压缩结果

最新实验结果如下：

| Fixture | 原始 tokens | 压缩 tokens | 节省 tokens | 压缩率 |
|:-:|----|:--:|:--:|:--:|
| `json_rows` | 27917 | 1658 | 26259 | 94.1% |
| `search_results` | 4323 | 470 | 3853 | 89.1% |
| `pytest_log` | 19359 | 2471 | 16888 | 87.2% |
| `plain_report` | 7754 | 4831 | 2923 | 37.7% |

解释：

- JSON/search/log 的收益很明显，说明类型感知压缩是有效的。
- plain text 收益较弱，这是预期结果。普通长文本没有明显结构，保守 extractive compression 不能激进删内容，否则容易静默丢信息。
- 对 nova-oc 这类工程场景，最值得优先处理的是 JSON、grep/search、日志，而不是幻想所有长文本都能稳定高压缩率。

## 5. Cache-adjusted 成本结果

### 5.1 不 retrieve 时

| Fixture | 节省 |
|---|---:|
| `json_rows` | 94.1% |
| `search_results` | 89.1% |
| `pytest_log` | 87.2% |
| `plain_report` | 37.7% |

这代表理想情况：模型只需要摘要和 hash，不需要回读原文。此时插件收益非常清晰。

### 5.2 full retrieve 时

| Fixture | full retrieve 后收益 |
|---|---:|
| `json_rows` | -5.9% |
| `search_results` | -10.9% |
| `pytest_log` | -12.8% |
| `plain_report` | -62.3% |

这是最重要的发现：如果调用方选择 `mode=full` 把完整原文重新返回给模型，那么前面的压缩收益会被抵消，甚至变成负收益。0.2.0 已把 bare retrieve 默认值改为 bounded summary。

原因是 full retrieve 不是免费操作：

1. 原文再次进入当前 turn。
2. 原文随后可能进入对话历史。
3. 后续 turn 继续携带它，哪怕是 cache read，也仍然有成本。
4. 对普通文本这种压缩率不高的内容，full retrieve 的负收益尤其明显。

这也解释了之前看到的问题：`headroom_retrieve` 取回 97KB 原文后，OpenCode 又把结果截断并落盘。那不是 CCR 失效，而是 retrieve 返回了太大的 tool output，触发了 OpenCode 自己的大输出保护。

### 5.3 targeted retrieve 后

| Fixture | targeted retrieve 后收益 |
|---|---:|
| `json_rows` | 92.2% |
| `search_results` | 79.3% |
| `pytest_log` | 83.4% |
| `plain_report` | 24.9% |

targeted retrieve 能保留大部分收益。它的本质是：

- CCR store 仍然保存完整原文，保证可逆。
- 默认不给模型全文，而是按 query/range/head/tail 返回小片段。
- 模型需要更多信息时，可以继续缩小查询范围分批取。

实验里 targeted retrieve 的 token 对比如下：

| Fixture | targeted retrieve tokens | full retrieve tokens |
|---|---:|---:|
| `json_rows` | 528 | 27917 |
| `search_results` | 424 | 4323 |
| `pytest_log` | 743 | 19359 |
| `plain_report` | 992 | 7754 |

这个差距说明改进方向明确：不要把 retrieve 设计成“回滚压缩”，而要设计成“对 CCR 原文做二次查询”。

## 6. 本次插件改进

本次已经把 `headroom_retrieve` 从“只返回完整原文”扩展为支持多种检索模式。

### 6.1 新增模式

| mode | 用途 |
|---|---|
| `query` | 按关键词返回匹配行和上下文 |
| `range` | 返回指定行号范围 |
| `head` | 返回开头 N 行 |
| `tail` | 返回末尾 N 行 |
| `summary` | 返回 CCR 元信息和首尾预览 |
| `full` | 返回完整原文 |

### 6.2 兼容 Headroom 语义

0.2.0 的无参数调用默认返回有 12000 字符硬上限的 summary：

```text
headroom_retrieve(hash)
```

需要逐字恢复原文时必须显式请求 full，且不要设置 `maxChars`：

```text
headroom_retrieve(hash, mode="full")
```

局部检索仍优先使用：

```text
headroom_retrieve(hash, mode="query", query="...", contextLines=2)
headroom_retrieve(hash, mode="range", startLine=120, endLine=180)
headroom_retrieve(hash, mode="tail", lines=80)
```

也就是说：

- 可逆性没有被削弱。
- 成本敏感的默认行为已经是 bounded summary。
- 真正需要全文时仍然可以显式 `mode=full`。

### 6.3 真实 OpenCode smoke

在 `~/test` 中用真实 OpenCode host 测试了：

```text
headroom_retrieve(
  hash="eaef709f5d8be1ec5fa9ea77",
  mode="query",
  query="FATAL status field mismatch",
  contextLines=1,
  maxMatches=3
)
```

debug 结果显示：

| 字段 | 值 |
|---|---:|
| tool | `headroom_retrieve` |
| decision | `skipped` |
| reason | `legacy_skip_tool` |
| display chars | 1160 |
| original chars | 1160 |
| original tokens | 290 |

这说明新的 retrieve 输出保持很小，并且不会被插件再次压缩。这个行为是对的：`headroom_retrieve` 本身是回读工具，应当跳过 after-hook 压缩，避免递归压缩。

## 7. 和 OpenCode 截断机制的关系

OpenCode 自带截断后，插件仍然有三点价值：

### 7.1 让模型先看到结构化摘要

OpenCode 截断一般保留前面一段，可能错过中间的 ERROR、尾部 traceback、JSON 异常行。插件可以按内容类型主动保留更重要的信息。

### 7.2 用 CCR hash 管理完整原文

OpenCode 的落盘路径是 host 级别的大输出保护；CCR hash 是模型可感知的语义索引。模型看到 hash 后知道：

- 这段输出被压缩过
- 原文可恢复
- 应当用 `headroom_retrieve` 按需查询

### 7.3 支持局部 retrieve

直接读 OpenCode 落盘文件，模型容易再次 `cat` 出大输出。`headroom_retrieve(mode=query/range)` 则把“读取大文件”变成“查询 CCR 原文的局部视图”。

因此推荐最终形态是：

```text
OpenCode outputPath 保存完整大输出
        ↓
Headroom plugin 仅为可信 Bash + 工作区内真实文件读取完整内容
        ↓
类型感知压缩，给模型小摘要 + CCR hash
        ↓
模型需要时通过 headroom_retrieve 局部查询
```

## 8. 成本收益判断

### 8.1 值得做的场景

| 场景 | 是否值得 |
|---|---|
| 大 JSON / API response | 很值得 |
| grep/rg/search 结果 | 很值得 |
| pytest/build/runtime log | 很值得 |
| 大型配置/lockfile 摘要 | 值得，但要保守 |
| 普通 prose 长文 | 谨慎，收益较低 |

### 8.2 不值得或要跳过的场景

| 场景 | 原因 |
|---|---|
| 小输出 | 压缩收益低，增加 hook 延迟 |
| 已包含 CCR marker 的输出 | 避免双重压缩 |
| `headroom_*` 工具输出 | 避免 retrieve 递归压缩 |
| context-mode 自己的工具输出 | 避免和 context-mode 重复治理 |
| 需要逐字审计的内容 | 应用 `mode=full` 或直接读原文 |

### 8.3 最终判断

在当前模型下：

- 如果只压缩 live tool output，插件不会明显破坏 provider cache。
- 如果模型大多数时候只看摘要，收益很高。
- 如果模型频繁 full retrieve，收益会变差甚至为负。
- 如果采用 targeted retrieve，JSON/search/log 仍能保留 79% 到 92% 的 cache-adjusted savings。

所以这个方向划算，但必须把 retrieve 设计成默认局部查询，而不是默认全文恢复。

## 9. 风险和限制

### 9.1 token 估算较粗

当前实验用 `chars / 4` 估算 token。它足够看趋势，但不能替代 provider 账单。

后续可以接入 tokenizer 或真实 API usage：

- prompt_tokens
- cache_read_input_tokens
- cache_creation_input_tokens
- completion_tokens

### 9.2 query retrieve 仍然是简单文本匹配

当前 `mode=query` 使用 NFKC-normalized、Unicode-aware 的关键词匹配行；单行紧凑 JSON 会先建立仅用于局部检索的 pretty view。它简单、离线、稳定，但不等于语义检索。

后续可以增强：

- JSONPath / key-aware query
- log level + traceback block query
- file path / line range query
- diff hunk query

### 9.3 plain text 压缩收益有限

普通文本没有稳定结构。为了避免静默丢信息，当前 text compressor 偏保守，因此收益低于 JSON/search/log。

这不是 bug，而是可逆优先策略的结果。

## 10. 建议的后续路线

### P0：保持当前策略

- 继续只 hook `tool.execute.after`
- 继续用 built-in policy 保留 `headroom_*`、context-mode 和精确内容工具；特殊 MCP 工具使用显式 `toolPolicy` 规则
- 继续保留 `headroom_retrieve(hash, mode="full")` 的逐字恢复能力
- tool description 中继续引导模型优先使用 query/range/head/tail

### P1：增强类型化 retrieve

建议下一步不是继续提高压缩率，而是提高 retrieve 的命中质量：

- JSON：支持按 key/value/status/code 查询，返回匹配对象片段
- search：支持按 file/path/line/query 查询
- log：支持按 level、exception、traceback、time window 查询
- diff：支持按 file 和 hunk 查询

这样可以进一步降低 retrieve token，同时减少模型拿不到关键信息的概率。

### P2：补充 provider 真实账单观测

0.2.0 的 `headroom_stats` 已经提供压缩结果、按 mode 的 retrieve token、full retrieve 比例、miss、延迟和允许为负的 net savings。若要判断生产账单，还应接入：

- provider usage 中的 cache read/write/uncached tokens

最关键的监控指标是：

```text
full_retrieve_tokens / tokens_saved
```

如果这个比例长期接近或超过 1，说明压缩收益被 retrieve 吃掉了。

## 11. 验证记录

本次验证命令：

```bash
bun test tests
bun run typecheck
bun run build
bun run bench:check
bun run bench:report
```

结果：

| 命令 | 结果 |
|---|---|
| `bun test tests` | 通过；具体数量随测试集增长 |
| `bun run typecheck` | 通过 |
| `bun run build` | 通过 |
| `bun run bench:check` | 质量和成本检查通过，报告哈希不变 |
| `bun run bench:report` | 成功显式生成报告 |
| 真实 OpenCode smoke | `headroom_retrieve` partial 参数生效 |

注意：根目录直接跑 `bun test` 可能会扫描未纳入本插件测试边界的 `headroom/` 上游目录。当前插件验证应使用：

```bash
bun test tests
```

## 12. 总结

OpenCode 自带截断解决的是“大输出不要直接撑爆上下文”；Headroom 插件解决的是“大输出进入上下文前如何变成模型可用的结构化小上下文”。两者不是重复关系。

从实验看，原生插件方向是合理的：

- 对 JSON/search/log，压缩收益显著。
- 只处理 live tool output，和 provider cache 策略兼容。
- CCR 保证可逆，不牺牲 correctness。
- full retrieve 会吃掉收益，因此 0.2.0 默认返回 bounded summary。
- 改进后的 query/range/head/tail retrieve 能保留大部分收益，并解决 retrieve 后再次触发大输出截断的问题。

最终建议：继续推进原生 OpenCode plugin，不走 proxy；MVP 阶段把重点放在“类型感知压缩 + CCR + 局部 retrieve + 可观测 stats/debug”，不要过早做全历史压缩或 ML compressor。
