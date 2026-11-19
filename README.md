# opencode-headroom

[中文](#中文) | [English](#english)

---

## 中文

一个 OpenCode 原生插件：在工具输出进入模型上下文前进行压缩，并在本地保存原文，可按哈希精确取回。

### 状态

早期项目，不再维护。代码保留以供参考（最后版本 0.3.2，见 [`CHANGELOG.md`](./CHANGELOG.md)）。

### 功能

- 对大体积工具输出做按类型压缩：JSON、源码（Python / TypeScript / JavaScript，基于 Lezer 语法树）、搜索结果、日志、diff、表格、HTML、纯文本
- 原文写入本地内容寻址仓库（CCR），压缩结果附带 24 位检索哈希
- `headroom_retrieve` 工具：按 `summary`、`query`、`range`、`head`、`tail`、`full` 模式有界取回原文
- `headroom_stats` 工具：CCR 统计与本地遥测（节省 token、取回次数、延迟等）
- 确定性的按工具策略（`toolPolicy`：压缩 / 保留），以及受信任的文件型输出读取
- 存储后端：进程内内存，或 Bun SQLite 持久化；支持 TTL、条目上限与会话隔离
- 会话级处理：Read 生命周期（过期/被替代的读取）、重复与跨轮片段折叠、压缩失败时回退原文

### 技术栈

TypeScript · OpenCode 插件 API（`@opencode-ai/plugin`）· Bun（运行时与 SQLite）· Zod · Lezer · Vitest

### 快速开始

在 OpenCode 项目中安装：

```sh
bun add @dahuangggg/opencode-headroom
```

在 `opencode.json` 中启用（完整配置示例见 [`opencode.json.example`](./opencode.json.example)）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["@dahuangggg/opencode-headroom", { "engine": "native" }]]
}
```

本地开发：

```sh
bun install
bun run test        # Vitest
bun run typecheck
bun run build       # tsc -> dist/
```

### 目录结构

```text
src/
  plugin.ts      OpenCode 钩子与生命周期
  engine/        路由与压缩编排
  compressors/   各格式压缩器
  session/       会话级去重与 Read 生命周期
  store/         CCR 存储（内存 / Bun SQLite）
  tools/         headroom_retrieve、headroom_stats
  source/        受信任的输出文件读取
tests/           单元与集成测试
benchmarks/      质量与性能基准
scripts/         打包检查脚本
DESIGN.md        架构设计说明
```

### 许可证

Apache-2.0，见 [`LICENSE`](./LICENSE)。

---

## English

A native OpenCode plugin that compresses tool outputs before they enter the model context, keeps the exact original locally, and lets you retrieve it by hash.

### Status

Early project, no longer actively maintained. The code is kept for reference (last release 0.3.2, see [`CHANGELOG.md`](./CHANGELOG.md)).

### Features

- Type-aware compression of large tool outputs: JSON, source code (Python / TypeScript / JavaScript via Lezer syntax trees), search results, logs, diffs, tables, HTML, plain text
- Exact originals stored in a local Content-Addressable Context Repository (CCR); compressed output carries a 24-character retrieval hash
- `headroom_retrieve` tool: bounded retrieval in `summary`, `query`, `range`, `head`, `tail`, or `full` mode
- `headroom_stats` tool: CCR totals and local telemetry (token savings, retrievals, latency)
- Deterministic per-tool policy (`toolPolicy`: compress / preserve) and trusted file-backed output reading
- Storage backends: process-local memory or persistent Bun SQLite, with TTL, entry limits, and session isolation
- Session-level handling: Read lifecycle (stale/superseded reads), repetition and cross-turn span folding, fail-open to the original on compressor errors

### Tech stack

TypeScript · OpenCode plugin API (`@opencode-ai/plugin`) · Bun (runtime and SQLite) · Zod · Lezer · Vitest

### Getting started

Install in an OpenCode project:

```sh
bun add @dahuangggg/opencode-headroom
```

Enable it in `opencode.json` (full example in [`opencode.json.example`](./opencode.json.example)):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["@dahuangggg/opencode-headroom", { "engine": "native" }]]
}
```

Local development:

```sh
bun install
bun run test        # Vitest
bun run typecheck
bun run build       # tsc -> dist/
```

### Directory structure

```text
src/
  plugin.ts      OpenCode hooks and lifecycle
  engine/        Routing and compression orchestration
  compressors/   Format-specific compressors
  session/       Session-level dedup and Read lifecycle
  store/         CCR storage (memory / Bun SQLite)
  tools/         headroom_retrieve, headroom_stats
  source/        Trusted output-file reading
tests/           Unit and integration tests
benchmarks/      Quality and performance benchmarks
scripts/         Package check scripts
DESIGN.md        Architecture overview
```

### License

Apache-2.0. See [`LICENSE`](./LICENSE).
