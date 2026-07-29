# Token-Efficient Execution Contract

本文档是 `codex-brain-pi-orchestrator` 的 Token-Efficient 执行模式的可审计契约，供独立审查窗口对照实现和测试进行逐项核验。

**版本**: v1.0  
**对应代码**: `D:\仓库集合\仓库1\codex-brain-pi-orchestrator-backup2\精简可运行版`  
**最后更新**: 2026-07-28

---

## 1. 适用范围与审计规则

本契约列出的每一项均可在源码中找到对应实现（含文件路径和关键行号）。独立审查窗口应逐项对照源码和测试确认，不采信本文档中的任何数值或描述而不经验证。

设计参考文档：`docs/06-token-efficient-design.md`（架构设计）。本契约是补充该文档的可审计验收标准，若两者冲突，以本契约和源码为准。

---

## 2. 一次 Planning，低/中风险本地 Gate + Stage 聚合 Review，高风险升级路径

### 2.1 一次 Planning 调用

- **源码位置**: `src/cli/commands/submit.ts`（M4 治理路径仅调用一次 `brain.generatePlan`）
- **规则**: 每个 run 只允许一次 Codex planning 调用。Planning 输出解析为 `StructuredTaskSpec[]`，分发到各 stage。
- **审计验证**: 搜索 `submit.ts` 中所有 Codex/LLM 调用点，确认唯一的 planning 入口。

### 2.2 低/中风险 → Stage 聚合 Review

- **源码位置**: `src/core/review-granularity.ts:shouldDoTaskLevelReview()` (line 12)
- **规则**: 在 `token-efficient` 模式下，`riskLevel` 为 `low` 或 `medium` 且非重试（`attemptNumber === 1`）的任务，跳过逐任务 Codex review，改由 stage 聚合 review 处理。
- **源码位置**: `src/core/stage-scheduler.ts:execTask()` (line ~1316)，检查 `isTokenEfficientMode()` 和 `shouldDoTaskLevelReview()`，满足条件时设置状态为 `review_skipped`。
- **审计验证**: 运行 `SELECT-01` 测试（`tests/core/06-token-efficient-mode.test.ts`），验证 low risk + 少文件任务绕过逐任务 review。

### 2.3 高风险 → Per-Task Review（升级路径）

- **源码位置**: `src/core/review-granularity.ts:shouldDoTaskLevelReview()` (line 30)
- **规则**: `spec.riskLevel === 'high'` 时强制逐任务 Codex review，无论 execution mode。
- **审计验证**: 运行 `SELECT-05` 测试，验证 high risk 任务仍走 `token-efficient` 模式（保留 Codex review）。

---

## 3. TaskPacket 文件/字符数上限与 Retry/Resume 增量约束

### 3.1 TaskPacket 上限

- **源码位置**: `src/core/stage-scheduler.ts:SchedulerConfig` (line ~416)
  - `taskPacketMaxContextFiles`: 默认 5（每个 task 最多包含的上下文文件数）
  - `taskPacketMaxContextChars`: 默认 500（每个 task 上下文最大字符数）
- **规则**: 超过上限时，scheduler 应降级（拆分 task 或拒绝创建）。

### 3.2 Retry 上限

- **源码位置**: `src/core/stage-scheduler.ts:SchedulerConfig.maxReworkCount` (default: 2)
- **规则**: 每个 task 最多允许 `maxReworkCount` 次重新执行。超出后 task 进入 `waiting_decision`，stage 暂停等待人工决策。
- **源码位置**: `src/core/stage-scheduler.ts:processStage()` retry budget check (line ~790)
- **审计验证**: `tests/core/bounded-retry.test.ts` 验证重试上限。

### 3.3 Resume 增量约束

- **源码位置**: `src/core/stage-scheduler.ts:resumeFromWorkerCompleted()` (line ~1431)
- **规则**: Resume 时跳过 Pi 重新执行（worktree/branch/WorkerResult 已保存），仅继续 quality gate → Codex review → integration。不重复消耗 Pi token。

---

## 4. Review Cache Key 与隐私约束

### 4.1 Cache Key 组成

- **源码位置**: `src/core/review-cache.ts:computeReviewCacheKey()` (line 158)
- **Key 字段**:
  - `baseCommit`: 基准 commit SHA
  - `diffHash`: diff 内容的 SHA-256（不存储原始 diff）
  - `qualityGateConfigHash`: quality gate 配置的 SHA-256 JSON hash
  - `reviewerModel`: 审查模型标识（默认 `codex-cli`）
  - `reviewerVersion`: 审查器版本（默认 `default`）
  - `riskPolicyHash`: 风险策略的 SHA-256 JSON hash
- **隐私**: cache key 中不包含任何原始 diff、prompt、文件路径或凭据——仅含不可逆哈希。

### 4.2 缓存策略

- **源码位置**: `src/core/review-cache.ts:DEFAULT_CACHE_CONFIG` (line 62)
  - 最大条目数: **100**
  - TTL: **1 小时**（3,600,000 ms）
  - 仅缓存 `approved` 结果
- **淘汰策略**: LRU（最近最少使用），进程内缓存（不跨进程、不持久化）
- **失效条件**: 任一 cache key 组件变化即视为 miss

---

## 5. synthetic / estimated / confirmed / unavailable 分类

- **源码位置**: `src/core/token-telemetry.ts`（Ledger 数据结构）
- **严格分类**:

| 分类 | 含义 | 触发条件 |
|------|------|---------|
| `synthetic` | 合成数据，非真实 Provider 调用 | 使用 fake Worker/Reviewer 时 |
| `estimated` | 预估值 | 调用前通过 `preCheckBudget()` 估算 |
| `confirmed` | 实际确认值 | Provider 返回后通过 `postCheckBudget()` 记录 |
| `unavailable` | 不可用 | 无法获取 token 数据时（错误、超时等） |

- **审计验证**: 检查 ledger 记录中每条 entry 的分类字段与调用类型的一致性。

---

## 6. 单逻辑调用 = 单 Ledger 不变量

- **源码位置**: `src/core/stage-scheduler.ts:execTask()`
  - `piLedgerSink`: 每个 Pi worker 调用创建独立的 `SqliteLedgerSink`（line ~1107）
  - `reviewLedgerSink`: 每个 Codex review 调用创建独立的 `SqliteLedgerSink`（line ~1380）
- **规则**: 每个逻辑 Provider 调用（Pi worker / Codex review / quality gate）最多产生一条 ledger 记录。
- **审查校验**: 搜索 ledger 写入点，确认不存在同一 attempt 产生多条记录。

---

## 7. Deterministic Fake A/B 要求

### 7.1 输入一致性

- **源码位置**: `tests/core/06-token-efficient-mode.test.ts` (BENCH-03)
- **规则**: Sequential 和 Orchestrated 两种模式必须使用相同的任务输入、fake Provider 延迟配置和验收条件。
- **审计验证**: 检查 `BENCH-03` 是否为两种模式创建完全相同的 task specs。

### 7.2 三轮要求

- **规则**: 每种模式至少运行 **3 轮**，报告中位数和范围。
- **报告字段**:
  - 最终正确性（run status、merged task count）
  - Codex 调用数（input/output/cache tokens）
  - Pi token 消耗（input/output）
  - total 和 weighted cost
  - wall time（中位数 + 范围）
  - retry/failure/recovery 次数
- **源码位置**: `tests/helpers/benchmark-fixtures.js:runRepeated()` 工具函数

### 7.3 Fake 限制声明

> **本项目的所有 Token 节省数据均来自 fake/disposable Provider。Fake 仅能证明调度逻辑的正确性（scheduling correctness），不能证明真实 Provider 环境下的 Token 节省幅度。真实 Provider 的 A/B 对比需要用户单独授权并运行 `allowRealWorker: true` 配置。**

---

## 8. 实现追溯表

| 契约条目 | 源码文件 | 关键行号 |
|---------|---------|---------|
| 一次 Planning | `src/cli/commands/submit.ts` | M4 governance path |
| Stage 聚合 Review | `src/core/review-granularity.ts` | 12, 42-50 |
| 高风险升级 | `src/core/review-granularity.ts` | 30 |
| TaskPacket 上限 | `src/core/stage-scheduler.ts` | `taskPacketMaxContextFiles/Chars` |
| Retry 上限 | `src/core/stage-scheduler.ts` | `maxReworkCount`, ~790 |
| Resume 增量约束 | `src/core/stage-scheduler.ts` | ~1431 |
| Cache Key | `src/core/review-cache.ts` | 158-175 |
| Cache TTL/LRU | `src/core/review-cache.ts` | 62-67 |
| Token 分类 | `src/core/token-telemetry.ts` | Ledger 接口 |
| 单 Ledger 不变量 | `src/core/stage-scheduler.ts` | ~1107, ~1380 |
| Fake A/B 测试 | `tests/core/06-token-efficient-mode.test.ts` | BENCH-03/04 |
| Execution Mode | `src/core/execution-mode.ts` | 89-125 |

---

## 9. 与 `docs/06-token-efficient-design.md` 的关系

`docs/06-token-efficient-design.md` 是本契约的设计参考文档，描述架构和思路。本契约 (`docs/TOKEN-EFFICIENT-CONTRACT.md`) 是独立审查的验收标准，必须以源码和测试为准。两者冲突时，以本契约和源码为准。

---

*本契约由 P0-3 返工窗口根据源码和测试实际状态编写，供下一个独立审查窗口核验。*
