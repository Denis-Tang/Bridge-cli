# 系统设计总览

## 总体架构

```
User / Codex Desktop
        |
        v
brainctl submit
        |
        v
Orchestrator
  |-- Codex Brain Adapter
  |-- Task Planner
  |-- DAG Scheduler
  |-- SQLite State Store (Node 24 内置 `node:sqlite`)
  |-- Pi RPC Worker Pool
  |-- Git Worktree Manager
  |-- Scope Validator
  |-- Quality Gate Runner
  |-- Codex Reviewer / CodexCliReviewer
  |-- LocalRuleReviewer (fallback)
  |-- Merge Manager
  |-- Decision Gates
  |-- Obsidian Recorder
  |-- Crash Recovery
```

## 角色边界

### Codex Brain（大脑）
- 理解需求、拆任务、建 DAG
- 做技术决策、审查 diff（通过 `CodexReviewer` 或 `CodexCliReviewer`）
- 决定返工或合并
- **禁止**：在缺少产品体验决策时擅自改产品行为

### Pi Worker（施工员）
- 只执行明确施工单，通过 `buildPiWorkerPrompt()` 构造严格 prompt
- 在独立 Git Worktree 中修改授权文件
- 提交后返回结构化结果，通过 `WorkerResult` JSON 标记块解析
- 支持超时和中止（SIGTERM → SIGKILL）
- 日志写入前自动脱敏（API Key、Auth Header、数据库密码等）
- **禁止**：扩大范围、改产品体验、读取密钥、push 到远程

### Orchestrator（调度器）
- 提供 `brainctl` CLI
- 管理任务、Worker、SQLite 状态
- 执行质量门检查
- 自动合并通过的任务
- 故障恢复

## 运行闭环

1. 用户提交自然语言需求
2. Codex Brain 生成 `JobRequest` 和 `BrainPlan`
3. Task Planner 拆出 `TaskSpec[]` 和依赖 DAG
4. Scheduler 找到可运行任务
5. Worktree Manager 为任务创建 branch/worktree
6. Pi Worker 读取 `TaskSpec` 并执行施工
7. Worker 返回 `WorkerResult`
8. Scope Validator 检查实际 Git diff 是否越界
9. Quality Gate Runner 跑测试、构建、lint
10. Codex Reviewer / CodexCliReviewer 审查 diff（`--reviewer codex` 使用真实 Codex CLI，默认 `LocalRuleReviewer`）
11. Merge Manager 合并通过的 commit
12. Recorder 写 Obsidian 记录

## 设计原则

1. Codex 做 Brain，Pi 做 Worker，职责分离
2. 提示词不是安全边界 — 必须用 Git diff、路径白名单、命令策略校验实际修改
3. 每个任务独立 branch + worktree + Pi session
4. 所有关键通信走 JSON Schema，不靠自然语言判断完成
5. SQLite（Node 24 内置 `node:sqlite`）是事实状态源，Markdown/Obsidian 是用户可读输出
