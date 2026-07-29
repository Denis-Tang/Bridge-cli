# HANDOFF-BOUNDED-RETRY — 有限重试与失败状态收敛

交付日期：2026-07-27

## 问题

P0-3：Scheduler 使用 review 的 `reworkCount` 判断上限，但生产链从未递增该字段，
导致 worker/scope/quality gate/review 失败后可能无限创建 attempt。

## 修复半成品的主要错误

### 错误 1：字符串猜测式失败分类

原 `shouldRetry()` 使用 `reason.startsWith(...)` 和 `reason.includes(...)` 进行失败分类。
问题：
- 未识别的 failure 默认按 transient 重试 → 可能无限循环
- `unknown` 前缀自动重试 → fail-open
- `attemptStatus === 'failed'` 无理由时也重试 → fail-open
- 字符串匹配不可靠（如 `scope_violation` 用 `includes`，可能误匹配）

**修复**：重写为 `classifyFailure()` — 结构化分类，使用 `FailureCategory` 枚举，
未知失败 fail-closed（不可重试）。

### 错误 2：exhausted 任务被 allOk 检查跳过

原代码在 stage 最终成功判断中 `continue` 跳过 exhausted 任务，导致：
- Non-retriable 失败的任务被"跳过"后，stage 仍可 integrate 和 completed
- 违反"不允许跳过失败任务后成功"的原则

**修复**：
- Non-retriable 失败任务也暂停 stage（不再仅 skip）
- allOk 检查不再跳过 exhausted 任务
- 存在 exhausted 任务时阻止 integration 和 stage completion

### 错误 3：Promise.allSettled rejection 仅记日志

原代码 `Promise.allSettled()` 中 rejection 只记录事件，不更新 attempt/task/stage 状态。

**修复**：为每个 `execTask` 调用包装 `.catch()` 处理器，在 rejection 时：
- 更新 task 状态为 `failed`
- 更新 stage 状态为 `paused`
- 释放关联的 path locks
- 记录结构化事件

### 错误 4：Stage deadlock 事件缺少结构化信息

原 deadlock 事件只写 `console.log` 和 stage paused，无结构化原因。

**修复**：新增 deadlock 事件，包含每个被阻塞任务的：
- 缺失依赖列表
- 锁冲突数
- 阻塞原因分类

### 错误 5：Non-retriable 失败后 stage 继续运行

原逻辑在 non-retriable 失败（scope/privacy/security 等）时仅将 task 标记为 `waiting_decision`，
不影响 stage 流程，让 stage 在其他任务完成后正常 integrate。

**修复**：Non-retriable 失败现在也暂停 stage，与 retry-exhausted 行为一致。

## 解决方案

### 1. 重写 `src/core/retry-policy.ts`

结构化失败分类模块，包含：

- `FailureCategory` 枚举 — 11 个类别（transient, quality, review, scope, security, privacy, product_decision, cancel, unverifiable, data_corruption, unknown）
- `classifyFailure(attemptStatus, exitReason)` — 结构化分类，fail-closed
- `classifyFailureFromWorkerResult()` — 额外检查 `productDecisionRequired`
- `maxAllowedAttempts(maxReworkCount)` — `maxReworkCount + 1`
- `checkRetryBudget()` — 综合检查 attempt 计数 + 结构化分类

向后兼容：保留原 `shouldRetry()`, `shouldRetryFromWorkerResult()` API。

### 2. 修改 `src/core/stage-scheduler.ts`

**`processStage()` 变更：**
- 所有 non-retriable 失败 → stage paused（不再跳过）
- allOk 检查：任何 exhausted 任务 → 阻止 integration
- 结构化 deadlock 事件（含 blocked task 详情）
- `Promise.allSettled` rejection → `.catch()` wrapper 标记 task/stage 失败并释放锁
- 事件记录增加 `failureCategory` 字段

**`execTask()` 变更：**
- `.catch()` wrapper 在 pool 入队时捕获未处理 rejection

### 3. 修改 `src/core/state-machine.ts`

- Task 状态：`waiting_decision → failed` 转换（允许从等待决策状态进入失败终态）

### 4. 修复 `src/adapters/project-adapter.ts`

- 编译错误：添加缺失的 `isAbsolute` import（原代码使用 `path.isAbsolute` 但未导入）

### 5. 更新 `tests/core/stage-scheduler.test.ts`

- "pauses stage when rework limit exceeded" 测试：从旧的 review.reworkCount 语义改为真实 attempt 计数语义（seeds 3 个 actual attempts）

### 6. 新增 `tests/core/bounded-retry.test.ts`

39 个测试（17 unit + 22 integration）：

## 结构化失败分类表

| 类别 | 是否重试 | 匹配模式 | 最终 task 状态 | 最终 stage 状态 |
|-----|---------|--------|---------------|---------------|
| `TRANSIENT` | ✅ | `wt_fail:`, `worker_result_missing`, `exception:` | 取决于重试结果 | 取决于重试结果 |
| `QUALITY` | ✅ | `qg_failed:` | 取决于重试结果 | 取决于重试结果 |
| `REVIEW` | ✅ | `review:`, `rework_required` | 取决于重试结果 | 取决于重试结果 |
| `SCOPE` | ❌ | `scope:` | `waiting_decision` | `paused` |
| `SECURITY` | ❌ | `security:` | `waiting_decision` | `paused` |
| `PRIVACY` | ❌ | `privacy:` | `waiting_decision` | `paused` |
| `PRODUCT_DECISION` | ❌ | `product_decision:`, `blocked:` | `waiting_decision` | `paused` |
| `CANCEL` | ❌ | `canceled:`, `canceled` | `canceled` | `canceled` |
| `UNVERIFIABLE` | ❌ | `unverifiable`, `expected_write_missing`, `real_reviewer_empty_diff` | `waiting_decision` | `paused` |
| `DATA_CORRUPTION` | ❌ | `resume:` (corrupted) | `waiting_decision` | `paused` |
| `UNKNOWN` | ❌ | 所有未识别失败 | `waiting_decision` | `paused` |

**语义**：`maxReworkCount=2` → 初次 attempt 之外最多再施工 2 次 → 最多 3 个 attempt。
Retry 预算来自真实 attempt 记录计数；resume 不重置或绕过耗尽状态。

## 测试结果

```
$ npx vitest run tests/core/bounded-retry.test.ts tests/core/stage-scheduler.test.ts

 Test Files  2 passed (2)
      Tests  44 passed (44)
```

### bounded-retry.test.ts（39 tests, all passed）

**Unit — classifyFailure (17 tests):**
- product_decision/privacy/security/cancel/scope/unverifiable/resume_corruption/blocked/no_gates → non-retriable ✅
- worktree_failure/worker_missing/exception/quality_gate/review_rejection/rework_required → retriable ✅
- unknown/unrecognized → fail-closed ✅
- failed with no matching reason → fail-closed ✅

**Unit — checkRetryBudget (6 tests):**
- maxAllowedAttempts(2) = 3 ✅
- No/1/3 attempts → correct budget ✅
- Canceled excluded from count ✅

**Integration — StageScheduler (16 tests):**
- 3x review reject → exactly 3 attempts, stage paused, no 4th ✅
- Scope/Security/Privacy/Product/Cancel/Unverifiable/ResumeCorrupt/Blocked → 1 attempt only ✅
- Mixed exhausted + approved → stage NOT completed, NOT integrated ✅
- Governance off → still retry bounded ✅
- Resume exhausted → no re-dispatch ✅
- Two tasks normal → stage completed, run completed ✅
- Worktree failure → retries to limit ✅
- Unknown failure → fail-closed ✅
- maxReworkCount=0 → at most 1 attempt ✅

### stage-scheduler.test.ts（5 tests, all passed）
- All 5 pre-existing tests pass (1 updated for P0-3 semantics) ✅

### 完整套件

- Build: `tsc -p tsconfig.json` → clean ✅
- Full test: 763 tests, 5 pre-existing failures (4 benchmark fixture transform error + 1 config portable path issue) — 无新增回归 ✅

## 尚未闭合的风险

1. **硬暂停时锁竞争**：Token 预算硬暂停保留锁（`preserveLocks=true`），若用户长期不恢复，锁资源泄漏。当前 resume 重入在 `startRun` 中检测 paused stage 立即返回，无超时机制。
2. **Non-retriable 暂停后恢复**：当前 non-retriable 失败暂停 stage 后，若用户直接恢复（不修改任务状态），会再次检测到同一 attempt 的 non-retriable failure 并再次暂停 — 这是预期行为（需要人为处理），但缺乏恢复指引。
3. **同时多个 non-retriable 任务**：当 stage 有多个 non-retriable 失败任务并发执行时，第一个检测到的会暂停 stage，其他正在运行的任务会继续完成。这些任务的结果会在下次 resume 时处理。
4. **Promise rejection 竞争**：虽然添加了 `.catch()` wrapper，但若多个 rejection 同时发生，对 stage 状态更新的串行化依赖 SQLite 事务（由 SqliteStateStore 保证）。
