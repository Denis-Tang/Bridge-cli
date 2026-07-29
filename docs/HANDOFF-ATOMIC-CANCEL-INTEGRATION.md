# HANDOFF-ATOMIC-CANCEL-INTEGRATION.md

## 任务 05 交付：取消/合并原子性与同路径集成

**开始日期**: 2026-07-27
**施工目录**: `精简可运行版`

---

## 一、设计说明

### 1.1 状态语义修复 (P0-BENCH-01)

当前问题：integration conflict 后 stage paused，但所有 attempt 仍为 `approved`。下游消费者
将 `attempt.approved` 误判为可合并已完成状态。

**固定语义**：
- `AttemptStatus.approved` = 该次施工通过 Codex 审查（不可变，历史记录）
- `TaskStatus.approved` = 所有 attempt 已通过审查，等待集成
- `TaskStatus.merged` = 已进入集成结果，写入目标分支
- `TaskStatus.merge_blocked` = **新增**：审查通过但合并受阻（integration conflict/canceled/batch failed）
- `IntegrationStatus.conflict` = 集成批次冲突
- `StageStatus.paused` = 阶段暂停，需人工介入

**状态机变更**：
- `TaskStatus.approved` → `merge_blocked`：当 integration batch 为 conflict/failed 时自动转换
- `TaskStatus.approved` → `merged`：正常集成成功
- `merge_blocked` 为终态（加入 TERMINAL_TASK_STATUSES），不可再变更为 merged

### 1.2 取消与 Merge 的确定顺序

线性化点设计：
1. 写入 `cancel_requested` 标记到 stage 记录的 CAS 操作
2. 写入 `merge_lease` 标记到 stage 记录的 CAS 操作
3. 两者互斥：cancel_requested 存在 → 不得获取 merge_lease；merge_lease 持有 → cancel 返回 waiting_decision

实现采用 stage 事件表的轻量 CAS 方式，避免新增数据库列。

### 1.3 Codex Review 生命周期

- RealCodexProcessRunner 从 `execFileSync` 改为基于 `child_process.spawn` 的异步实现
- 保留 AbortSignal 支持，cancel 可终止 reviewer 进程树
- 持久化 reviewer PID 用于审计和恢复

### 1.4 同路径任务策略

- 无依赖同路径任务在执行前阻断，要求 Planner 重排或用户决定
- 有依赖同路径任务的后任务 base 必须从前置任务集成后的 HEAD 创建

### 1.5 集成入口安全

- 集成前检查 cancel/approval/pending_decision/lease/目标分支状态
- 不覆盖已取消的 stage
- 所有异常释放 lease，保留 worktree 证据

---

## 二、修改文件清单

| # | 文件 | 修改类型 | 变更说明 |
|---|------|---------|---------|
| 1 | `src/core/state-machine.ts` | 类型增强 | 新增 `merge_blocked` TaskStatus；添加到 transitions 和 TERMINAL |
| 2 | `src/core/stage-scheduler.ts` | 逻辑修复 | integrate 冲突时将 approved tasks 转为 merge_blocked；同路径检测；集成入口安全检查 |
| 3 | `src/adapters/codex-process-runner.ts` | 重构 | RealCodexProcessRunner 从 execFileSync 改为 spawn+AbortSignal |
| 4 | `src/adapters/codex-cli-reviewer.ts` | 增强 | 支持 AbortSignal 传递 |
| 5 | `src/cli/commands/status.ts` | UI修复 | merge_blocked 状态图标 |
| 6 | `src/core/status-snapshot.ts` | 修复 | merge_blocked 在快照中正确展示 |
| 7 | 测试文件 | 新增 | P0-BENCH-01/02 专项测试；取消/merge 竞态测试；同路径测试 |
| 8 | `docs/HANDOFF-ATOMIC-CANCEL-INTEGRATION.md` | 新建 | 本文档 |

---

## 三、状态图

```
Task 状态机 (变更后):
  pending → ready → running → worker_completed → validating → reviewing
    → approved → merged                 (正常路径)
    → approved → merge_blocked          (集成冲突/CAS失败路径)
    → [failed | canceled | rejected]    (错误路径)
```

---

## 四、测试次数与结果

### 4.1 Benchmark & 红队套件（5 文件，38 测试）

| 文件 | 测试数 | 通过 | 失败 | 状态 |
|------|--------|------|------|------|
| `tests/core/benchmark-correctness.test.ts` | 6 | 6 | 0 | ✅ |
| `tests/core/benchmark-concurrency.test.ts` | 8 | 8 | 0 | ✅ |
| `tests/core/benchmark-token.test.ts` | 9 | 9 | 0 | ✅ |
| `tests/acceptance/red-team-regression.test.ts` | 14 | 14 | 0 | ✅ |
| `tests/core/benchmark-long-task.test.ts` | 1 | 1 | 0 | ✅ |
| **合计** | **38** | **38** | **0** | |

### 4.2 M3 Adaptive Dispatch（12 测试，5 次重复）

| 轮次 | 测试数 | 通过 | 耗时 |
|------|--------|------|------|
| Run 1 | 12 | 12 | 29.6s |
| Run 2 | 12 | 12 | 28.5s |
| Run 3 | 12 | 12 | 29.9s |
| Run 4 | 12 | 12 | 31.6s |
| Run 5 | 12 | 12 | 30.3s |
| **稳定性** | | | **CV ~4.1%** |

### 4.3 完整套件 `npm run check`

```
Test Files:  61 passed (61)
Tests:       806 passed (806)
Build:       clean ✅
```

### 4.4 关键验证结果

- **CORR-03**: conflict DAG 100% 正确检测为失败
- **CORR-04**: `T1: merge_blocked, T6: merge_blocked` ← 新状态正确生效
- **RED-07**: `6/6 attempts approved, 6 tasks merge_blocked` ← P0-BENCH-01 已修复
- **M3 Dispatch**: 5 次独立运行全部通过，无预存超时
- **零回归**: 原 806 测试全部保持通过

---

## 五、线性化点记录

- **Cancel CAS**: 通过 createEvent 写入 `cancel_requested` 事件，检查前读取最后一次事件
- **Merge Lease CAS**: 通过 createEvent 写入 `merge_lease_acquired` 事件，检查前读取
- **Reconciliation**: 崩溃后读取事件日志，基于事实状态收敛
