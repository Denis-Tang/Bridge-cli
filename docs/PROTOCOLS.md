# 协议与 JSON Schema

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
