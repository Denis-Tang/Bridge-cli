# 协议、状态记录与 JSON Schema

更新日期：2026-08-02

所有关键通信均通过 JSON Schema 验证。共有 8 个协议：

## 1. JobRequest（需求请求）

用户提交的施工需求，包含项目信息和自然语言描述。

必填字段：`jobId`、`projectId`、`projectRoot`、`requestText`、`createdAt`

## 2. BrainPlan（大脑规划）

Codex Brain 根据需求生成的施工规划，包含任务列表、依赖关系和风险评估。

## 3. TaskSpec（任务规范）

单个任务的详细施工说明，指定授权路径、禁止路径、允许命令、质量验收标准。

必填字段：`taskId`、`title`、`goal`、`allowedPaths`、`riskLevel` 等

## 4. WorkerResult（Worker 结果）

Pi Worker 执行任务后返回的结构化结果，包含修改文件、commit hash、检查结果。

`status` 枚举：`completed`、`failed`、`blocked`、`needs_decision`、`scope_violation`

## 5. ReviewResult（审查结果）

Codex Brain 审查 diff 后的评审结论。

`status` 枚举：`approved`、`rework_required`、`rejected`、`needs_user_decision`

## 6. DecisionRequest（决策请求）

需要用户参与的技术或产品决策。

`type` 枚举：`product_experience`、`high_risk_operation`

## 7. MergeResult（合并结果）

分支合并操作的结果，包含冲突信息。

`status` 枚举：`merged`、`conflict`、`failed`、`skipped`

## 8. RunSummary（运行总结）

一次从提交到完成的全流程总结报告。

## 9. SQLite 运行证据（非 Provider JSON）

下列记录不是 Pi/Codex 可以自报的协议字段，而是 Orchestrator 在本地 SQLite 中生成和校验的控制证据：

- `PauseRecord`：绑定 run/stage、原因分类、所需专用批准和证据摘要。`resume` 必须使用活动记录的精确 `--confirm-pause <id>`，不能只凭 Stage 处于 paused 恢复。
- cost reservation：在真实 Provider spawn 前用 `BEGIN IMMEDIATE` 原子预留最坏金额，区分 reserved/spawned/confirmed/released/stale 和 `usage_unknown/unavailable`；stale 只能由 reconcile 按终止证据保守结算。
- attempt provenance：在 Worker spawn 前不可变地绑定 base commit、预期 branch/worktree、TaskPacket/prompt hash、worker/session 身份；重复写入不一致内容会失败。
- actual-path claim：Worker 返回后按实际 Git diff 原子声明 Stage 内路径所有权；与无依赖任务冲突时暂停，不能靠预计路径锁掩盖。
- Review coverage：记录 reviewed-through commit、final commit 与 partial/complete；只有最终 merge tree 与已审 integration tree 一致才可 complete。
- reconciliation report：`reconcile` 默认只读生成分类报告；只有 `--apply` 会执行保守动作并留下逐项事件。

这些 SQLite 记录和 Git 证据优先于 WorkerResult/ReviewResult 的自然语言摘要。

## Schema 位置

所有 schema 文件位于 `src/schemas/` 目录：

```
src/schemas/
├── job-request.schema.json
├── brain-plan.schema.json
├── task-spec.schema.json
├── worker-result.schema.json
├── review-result.schema.json
├── decision-request.schema.json
├── merge-result.schema.json
└── run-summary.schema.json
```
