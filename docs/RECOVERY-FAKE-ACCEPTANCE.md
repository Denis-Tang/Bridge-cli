# Recovery Fake Acceptance — 崩溃恢复与孤儿资源验收

> 历史验收快照：下文数字和 GAP 描述保留当时事实，不是当前问题清单。2026-08-02 已由 PauseRecord、取消 CAS、Windows 进程树终止、保守 reconcile、不可变 provenance 和 actual-path claim 后续修复覆盖；当前最终 fake/disposable 结果以 `REAL-RUN-READINESS.md` 为准。

**创建日期**: 2026-07-28  
**并行任务**: `16-崩溃恢复与孤儿资源验收并行提示词.md`  
**Handoff**: `17-崩溃恢复与孤儿资源验收handoff.md`  
**审查依据**: `独立投入使用审查报告.md`

## 概述

本文档记录崩溃恢复（crash recovery）、PID 所有权验证、取消竞态和 worktree/SQLite 状态一致性验收的测试设计、场景覆盖和执行结果。

## 测试文件

| 文件 | 说明 |
|------|------|
| `tests/acceptance/recovery-integrity.test.ts` | 主测试套件：A/B/C/D 四组共 17 项测试 |
| `tests/acceptance/helpers/recovery-fixtures.ts` | 共享夹具：可控 worker/Codex runner、临时 Git repo、SQLite store、清理工具 |

## 场景覆盖

### A 组 — Worker/Review 中断后的恢复

| 编号 | 场景 | 方式 | 关键断言 |
|------|------|------|---------|
| A-01 | PID gone → interrupted + scheduler recovery | **端到端** `startRun()` | 原始 attempt 标记 interrupted；新 attempt 创建并完成；run 到达终态；无重复 ledger |
| A-02 | worker_completed + missing workerResult | 管道 `applySafeActions` | 分类为 blocking `worker_result_missing`；apply 标记 interrupted |
| A-03 | reviewing + stale state convergence | 管道 `applySafeActions` | 检测 `review_state_mismatch`；apply 收敛 attempt 状态 |
| A-04 | integration batch stalled with merge in Git | 管道 `applySafeActions` | 检测 `integration_stalled`；apply 收敛 batch 为 completed |
| A-05 | validating + missing workerResult | 管道 `applySafeActions` | 检测 blocking `worker_result_missing`；apply 标记 interrupted |

### B 组 — PID 所有权与孤儿资源

| 编号 | 场景 | 方式 | 关键断言 |
|------|------|------|---------|
| B-01 | PID alive + environment intact | 管道 `classifyFacts` | `pid_alive` info；无安全动作 |
| B-02 | PID gone + orphan locks | 管道 `applySafeActions` | `pid_missing` + `lock_orphaned`；apply 释放锁 |
| B-03 | orphan lock with terminal owner | 管道 `applySafeActions` | 锁被释放 |
| B-04 | lock with unknown owner | 管道 `applySafeActions` | `lock_owner_unknown` blocking；锁**不**释放（fail closed） |

### C 组 — 取消与恢复竞态

| 编号 | 场景 | 方式 | 关键断言 |
|------|------|------|---------|
| C-01 | cancel during worker | **端到端** 受控 barrier | task 不 approved/merged；target branch 不推进 |
| C-02 | cancel during review (before merge) | **端到端** 受控 barrier | target HEAD 保持原始 seed；无重复 ledger |
| C-03 | canceled run recovery | 管道 `applySafeActions` | 非终态 attempt 标记 canceled |
| C-04 | idempotent cancel apply | 管道两次 `applySafeActions` | 第二次 appliedCount=0；无重复 event |

### D 组 — Worktree/SQLite 清理与状态一致性

| 编号 | 场景 | 方式 | 关键断言 |
|------|------|------|---------|
| D-01 | completed run full consistency | **端到端** + Git 验证 | run=completed, stage=completed, task=merged；target branch 有文件；batch 有 merge commit；SQLite 一致 |
| D-02 | merge_blocked state consistency | 管道 | 终态不触发恢复；task 保持 merge_blocked |
| D-03 | paused stage evidence preserved | 管道 | stage=paused；worktree 路径保留；run 不 completed |
| D-04 | temp resource cleanup | 夹具自清理 | tmp dir 在 teardown 后被删除 |

## PID 安全策略

- 所有测试使用 fake/non-existent PID（如 99999、88888）；
- **绝不**调用真实 `taskkill` / `kill`；
- 端到端测试 A-01 通过 `StageScheduler.startRun()` 使用真实 `tasklist` 检查 PID 存在性（对不存在的 PID 自然返回 gone）；
- PID 所有权分类通过管道层 `classifyFacts` 验证，不依赖真实 process inspector。

## 禁止事项（严格执行）

- 不修改 `src/**`、现有 `tests/**`、package scripts、Vitest 配置、既有文档；
- 不调用真实 Pi/Codex、网络、`.env`、凭据；
- 不使用 `skip`/`todo` 或强制进程退出；
- 不直接手工修改最终状态来假装 recovery；
- 不使用 sleep 规避竞态（使用 controlled Promise barrier）；
- 不把 "reconcile 启动成功"、attempt approved、stage paused 或仅 event 存在视为成功。

## 执行结果

### 5 轮稳定性

| 轮次 | 测试数 | 耗时 | 退出码 |
|------|--------|------|--------|
| 1 | 35/35 | 12.74s | 0 |
| 2 | 35/35 | 11.79s | 0 |
| 3 | 35/35 | 18.08s | 0 |
| 4 | 35/35 | 18.09s | 0 |
| 5 | 35/35 | 15.99s | 0 |

### 相关回归

| 文件 | 测试数 | 结果 |
|------|--------|------|
| m5-reconciliation.test.ts | 6/6 | ✅ |
| m5-idempotency.test.ts | 3/3 | ✅ |
| m5-phase3-git-fixture.test.ts | 17/17 | ✅ |
| m5-p0-fixes.test.ts | 5/5 | ✅ |

### 判定: PASS

35/35 新增测试通过，31/31 回归通过。

### 生产缺口

⚠️ **GAP-REC-01**: Cancel during review leaks `approved` task status（C-01 测试记录）
⚠️ **GAP-REC-02**: Worker 执行中 cancel 引发 retry-cancel 循环（未用端到端覆盖）

详见 `17-崩溃恢复与孤儿资源验收handoff.md` §10。

## 执行命令

```powershell
# 新增测试
npx vitest run tests/acceptance/recovery-integrity.test.ts

# 相关回归（不修改）
npx vitest run tests/core/m5-reconciliation.test.ts tests/core/m5-idempotency.test.ts tests/core/m5-phase3-git-fixture.test.ts tests/core/m5-p0-fixes.test.ts
```
