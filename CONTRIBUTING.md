# Contributing to Bridge

Bridge 的核心边界是：Codex 规划与审查，Pi 在隔离 worktree 中施工，SQLite 保存唯一调度状态。贡献不得绕过 95% 理解门、范围校验、质量门或合并审批。

## 本地验证

```powershell
npm ci
npm run check
```

- 测试只能使用 fake Provider 或 disposable Git 夹具。
- 不要提交 `.brainctl-dev`、数据库、日志、会话、Token、Cookie、`.env` 或真实项目内容。
- 涉及 Scheduler 的变更应同时覆盖取消、恢复、锁、依赖与失败收敛。
- 对 Token 或提速的效果声明必须给出同任务 sequential baseline；合成数据必须标为 synthetic。

## 提交范围

保持一次变更解决一个明确问题。提交说明应包含行为变化、验证命令、剩余风险，以及是否触及真实 Provider 路径。
