# 系统设计总览

更新日期：2026-08-02

## 总体架构

```text
User / Codex Desktop
        |
        v
brainctl submit / approve / resume / recover / reconcile
        |
        v
Orchestrator
  |-- Codex Brain + Structured Plan Validator
  |-- DAG Scheduler (strict stage barrier + rolling concurrency)
  |-- BudgetTracker / PostWorkerHandler / StageIntegrationCoordinator
  |-- SQLite State Store (Node 24 node:sqlite)
  |-- Pi RPC Worker + read-only clarification gate
  |-- Git Worktree Manager + Scope/Actual-Path ownership
  |-- Task/Stage Quality Gates
  |-- Codex CLI Reviewer
  |-- Pause/Recovery/Reconciliation services
  `-- localhost-only read-only Dashboard
```

## 角色边界

### Codex Brain

- 把需求转换为结构化分阶段 DAG，并在规划期补齐可证明的同路径依赖边。
- 回答 Pi 的纯技术澄清问题，受保护的产品、隐私、范围和费用决策必须回到用户。
- 审查高风险/返工任务以及每个 Stage 的最终 integration commit。
- 不得在缺少产品体验决策时擅自改变行为，也不得用 Reviewer 自报替代目标树证据。

### Pi Worker

- 每个 attempt 在独立 branch/worktree 中执行冻结的 TaskSpec。
- 施工前最多进行两轮只读问答和一次最终确认；达到至少 95% 且无未决问题后才启用施工工具。
- 澄清阶段原生只开放 `read,grep,find,ls`，并由 pre-execution guard 限制到 worktree 与授权上下文；提示词不是只读边界。
- 返回结构化 WorkerResult，但其 `completed` 自报只是一项输入，不能直接完成 Task。
- 禁止扩大范围、读取凭据、修改 worktree 外文件或 push 远程。

### Orchestrator

- SQLite 是唯一状态事实源；所有关键状态更新使用显式状态机和 CAS／专用事务。
- Stage 是严格屏障，同 Stage 内按依赖就绪滚动补位并发。
- 在 Provider spawn 前原子预留最坏金额；未知实际用量不会按 0 释放。
- 记录不可变 attempt provenance，在恢复时核对 base/branch/worktree/commit/changed-files hash。
- 对实际 diff 做 allowed/forbidden scope、completion evidence、actual-path claim、质量门和 Review。
- 取消使用 checkpoint 与进程树终止；reconcile 默认只读，只有 `--apply` 才执行保守修复。

### Dashboard

- 仅允许 `127.0.0.1`、`localhost` 或 `::1`。
- 使用 `DatabaseSync(..., { readOnly: true, timeout })`、`PRAGMA query_only=ON` 和 busy timeout 打开状态库。
- 没有 approve、resume、cancel、retry、recover、reconcile apply 或任意写 API；CLI 是唯一控制面。

## 运行闭环

1. `submit` 生成并校验结构化计划，冻结脱敏运行配置快照。
2. 用户批准；Scheduler 为依赖就绪任务原子获取预计路径锁。
3. 建立 attempt provenance、branch/worktree 与 diff base。
4. Pi 通过非提示词级只读澄清门后施工并返回 WorkerResult。
5. 统一 PostWorkerHandler 校验 scope、completion evidence、scope expansion 和 actual-path claim。
6. 任务质量门通过后，高风险/返工任务逐项 Review；token-efficient 低/中风险首轮可记录 `review_skipped`。
7. StageIntegrationCoordinator 在 integration worktree 合并任务，再跑 Stage 质量门。
8. 所有执行模式都审查最终 integration commit；输入超出完整覆盖代理上限时保持 partial 并暂停，不截断审查。
9. 审查后再次验证实际路径、目标分支漂移和 final merge tree，coverage 完整才合并目标分支。
10. 释放 Stage actual-path claims 与安全可清理 worktree；下一 Stage 才能开始。

## 恢复与一致性

- 每个暂停都有活动 PauseRecord；`resume` 必须提供精确 `--confirm-pause <id>`，并在专用批准完成后原子解析。
- `recover attempt` 只接纳最新 attempt 且必须匹配不可变 provenance。显式范围扩展只在本次恢复上下文生效，不改写原 TaskSpec。
- `reconcile` 诊断 PID、attempt、worktree、review 和金额 reservation 漂移；`--apply` 只执行分类器标记为安全的动作。
- migration 的每条版本变更与 `schema_migrations` 记录位于同一事务；Run/Stage/Task/Attempt 的普通状态 API 不允许越过专用恢复/收敛边界。

## 设计原则

1. 提示词不是安全边界；路径、工具、状态和金额都必须由代码强制。
2. Worker 自报、通过日志或单个事件都不是完成证据。
3. 每个 attempt 的 provenance、实际路径与 Review coverage 可追溯且不可静默改写。
4. 没有质量门、Reviewer unavailable、coverage partial 或状态不收敛时一律 fail closed。
5. fake/synthetic 证据与真实 Provider 证据分开报告；没有同任务 sequential A/B 就不宣称固定节省比例。
