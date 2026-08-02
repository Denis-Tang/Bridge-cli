# Token-Efficient Execution Contract

本文档是 Bridge (`bridge-orchestrator`) Token-Efficient 执行模式的当前可审计契约，供独立审查窗口对照实现和测试逐项核验。

**版本**: v1.1

**正式仓库**: `C:\Users\29672\Documents\bridge`

**最后更新**: 2026-08-02

---

## 1. 适用范围与审计规则

本契约列出的每一项均可在源码中找到对应实现（含文件路径和关键行号）。独立审查窗口应逐项对照源码和测试确认，不采信本文档中的任何数值或描述而不经验证。

设计参考文档：`docs/06-token-efficient-design.md`（2026-07-27 历史 Draft）。若两者冲突，以当前源码、测试和本契约为准。

---

## 2. 一次 Planning，低/中风险本地 Gate + Stage 聚合 Review，高风险升级路径

### 2.1 一次 Planning 调用

- **源码位置**: `src/cli/commands/submit.ts`（M4 治理路径仅调用一次 `brain.generatePlan`）
- **规则**: 每个 run 只允许一次 Codex planning 调用。Planning 输出解析为 `StructuredTaskSpec[]`，分发到各 stage。
- **审计验证**: 搜索 `submit.ts` 中所有 Codex/LLM 调用点，确认唯一的 planning 入口。

### 2.2 低/中风险 → Stage 聚合 Review

- **源码位置**: `src/core/review-granularity.ts:shouldDoTaskLevelReview()`
- **规则**: 在 `token-efficient` 模式下，`riskLevel` 为 `low` 或 `medium` 且非重试（`attemptNumber === 1`）的任务，跳过逐任务 Codex review，改由 stage 聚合 review 处理。
- **源码位置**: `src/core/post-worker-handler.ts:skipTokenEfficientReview()`；fresh 与 worker_completed resume 共用同一后处理实现，满足条件时设置状态为 `review_skipped`。
- **审计验证**: 运行 `SELECT-01` 测试（`tests/core/06-token-efficient-mode.test.ts`），验证 low risk + 少文件任务绕过逐任务 review。

### 2.3 高风险 → Per-Task Review（升级路径）

- **源码位置**: `src/core/review-granularity.ts:shouldDoTaskLevelReview()`
- **规则**: `spec.riskLevel === 'high'` 时强制逐任务 Codex review，无论 execution mode。
- **审计验证**: 运行 `SELECT-05` 测试，验证 high risk 任务仍走 `token-efficient` 模式（保留 Codex review）。

---

## 3. TaskPacket 文件/字符数上限与 Retry/Resume 增量约束

### 3.1 TaskPacket 上限

- **源码位置**: `src/core/stage-scheduler.ts:SchedulerConfig`
  - `taskPacketMaxContextFiles`: 默认 5（每个 task 最多包含的上下文文件数）
  - `taskPacketMaxContextChars`: 默认 500（每个 task 上下文最大字符数）
- **规则**: 超过上限时，scheduler 应降级（拆分 task 或拒绝创建）。

### 3.2 Retry 上限

- **源码位置**: `src/core/stage-scheduler.ts:SchedulerConfig.maxReworkCount` (default: 2)
- **规则**: 每个 task 最多允许 `maxReworkCount` 次重新执行。超出后 task 进入 `waiting_decision`，stage 暂停等待人工决策。
- **源码位置**: `src/core/stage-scheduler.ts:processStage()` 与 `src/core/retry-policy.ts`
- **审计验证**: `tests/core/bounded-retry.test.ts` 验证重试上限。

### 3.3 Resume 增量约束

- **源码位置**: `src/core/stage-scheduler.ts:resumeFromWorkerCompleted()` 与 `src/core/post-worker-handler.ts`
- **规则**: Resume 先复核不可变 provenance、adopted commit、branch/worktree、changed-files hash、批准扩展和活动 locks，然后跳过 Pi 重新执行。后续 scope、actual-path claim、quality gate 和 Review 决策与 fresh 路径共用同一实现；低/中风险首轮仍可按契约跳过逐任务 Review，但最终 integrated-tree Review 永远不能跳过。不重复消耗 Pi token。

---

## 4. Review Cache Key 与隐私约束

### 4.1 Cache Key 组成

- **源码位置**: `src/core/review-cache.ts:computeReviewCacheKey()`
- **Key 字段**:
  - `baseCommit`: 基准 commit SHA
  - `diffHash`: diff 内容的 SHA-256（不存储原始 diff）
  - `qualityGateConfigHash`: quality gate 配置的 SHA-256 JSON hash
  - `reviewerModel`: 审查模型标识（默认 `codex-cli`）
  - `reviewerVersion`: 审查器版本（默认 `default`）
  - `riskPolicyHash`: 风险策略的 SHA-256 JSON hash
- **隐私**: cache key 中不包含任何原始 diff、prompt、文件路径或凭据——仅含不可逆哈希。

### 4.2 缓存策略

- **源码位置**: `src/core/review-cache.ts:DEFAULT_CACHE_CONFIG`
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

- **源码位置**: `src/core/stage-scheduler.ts:execTask()` 与 `src/core/post-worker-handler.ts:runReview()`
  - `piLedgerSink`: 每个 Pi worker 调用创建独立的 `SqliteLedgerSink`
  - task Review／skip ledger：统一后处理器为每个逻辑调用写一条可分类记录
- **规则**: 每个逻辑 Provider 调用（Pi worker / Codex review / quality gate）最多产生一条 ledger 记录。
- **审查校验**: 搜索 ledger 写入点，确认不存在同一 attempt 产生多条记录。

---

## 7. Deterministic Fake A/B 要求

### 7.1 输入一致性

- **源码位置**: `tests/core/06-token-efficient-mode.test.ts` (BENCH-03)
- **规则**: Sequential 和 Orchestrated 两种模式必须使用相同的任务输入、fake Provider 延迟配置和验收条件。
- **审计验证**: 检查 `BENCH-03` 是否为两种模式创建完全相同的 task specs。

### 7.2 调用结构与时延证据

- `BENCH-01`/`BENCH-02` 各运行三轮 fake/disposable 调度，记录 Pi/Codex 调用数和 wall time。
- `BENCH-03` 使用相同 DAG、任务规格和验收条件直接比较 `default + maxParallel=1` 与 `token-efficient + rolling concurrency`：Pi 任务调用数必须相同，token-efficient 的 Codex 调用结构必须更少，wall time 必须更低。
- `BENCH-04` 只校验一个显式 `synthetic=true` 的调用结构计算器；它不得输出或断言 Provider Token 节省百分比。
- 这些测试证明调度结构，不证明真实模型的 Token、质量或金额降幅。

### 7.3 Fake 限制声明

> **本项目没有同任务真实 Provider sequential A/B。Fake/disposable 数据仅证明调度逻辑和调用结构，不能称为真实 Token 节省数据，也不能推导固定节省百分比。真实 Provider A/B 需要用户单独授权、金额预算硬门和相同验收标准。**

---

## 8. 实现追溯表

| 契约条目 | 源码文件 | 关键行号 |
|---------|---------|---------|
| 一次 Planning | `src/cli/commands/submit.ts` | M4 governance path |
| Stage 聚合 Review | `src/core/stage-integration.ts`、`src/core/stage-review.ts` | 最终 integrated-tree Review |
| 高风险升级 | `src/core/review-granularity.ts`、`src/core/post-worker-handler.ts` | task Review 决策 |
| TaskPacket 上限 | `src/core/stage-scheduler.ts` | `taskPacketMaxContextFiles/Chars` |
| Retry 上限 | `src/core/stage-scheduler.ts`、`src/core/retry-policy.ts` | `maxReworkCount` |
| Resume 增量约束 | `src/core/stage-scheduler.ts`、`src/core/post-worker-handler.ts` | shared post-worker path |
| Cache Key | `src/core/review-cache.ts` | `computeReviewCacheKey` |
| Cache TTL/LRU | `src/core/review-cache.ts` | `DEFAULT_CACHE_CONFIG` |
| Token 分类 | `src/core/token-telemetry.ts` | Ledger 接口 |
| 单 Ledger 不变量 | `src/core/stage-scheduler.ts`、`src/core/post-worker-handler.ts` | Pi/task Review logical calls |
| Fake 调用结构测试 | `tests/core/06-token-efficient-mode.test.ts` | BENCH-01..04 |
| Execution Mode | `src/core/execution-mode.ts` | `resolveExecutionMode` |

---

## 9. 与 `docs/06-token-efficient-design.md` 的关系

`docs/06-token-efficient-design.md` 是本契约的设计参考文档，描述架构和思路。本契约 (`docs/TOKEN-EFFICIENT-CONTRACT.md`) 是独立审查的验收标准，必须以源码和测试为准。两者冲突时，以本契约和源码为准。

## 10. 最终 integrated-tree Review 与覆盖

- default、simple、token-efficient 三种模式都必须审查每个 Stage 的最终 integration commit；逐任务 `review_skipped` 不能绕过此门。
- Reviewer 输入不截断。完整 UTF-8 输入超过 524,288 bytes 或 20,000 lines 时不调用 Reviewer，coverage 保持 `partial`，Stage 暂停。
- bytes/lines 仅是 `proxy_not_token` 运维指标，不能写成 Provider token 上限或节省证据。
- Review 后必须复核实际路径、目标分支漂移和 final merge tree；只有已审树与最终树一致时 coverage 才能为 `complete`。

---

*本契约随 2026-08-02 可靠性与 scheduler 重构更新；历史验收数字见 `HISTORY.md`。*
