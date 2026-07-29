# Codex Brain + Pi Worker Orchestrator

这是一个本地独立调度器：Codex 负责规划、Pi 技术答疑、关键审查和合并决策，Pi Worker 在隔离 worktree 中执行受约束的任务，SQLite 保存调度状态和审计记录。

## 当前状态

当前是 **私人 Windows 环境基本稳定可用版**。已完成受控的真实 DeepSeek Pi + Codex CLI 链路验证；尚未完成同任务 sequential baseline 对照，因此不宣称已经证明 Codex Token 节省比例。

- TypeScript 构建通过。
- 最终 `npm run check`：69 个测试文件、930 项测试全部通过。
- 完整长任务最终修正版连续三轮 13/13 通过；恢复、隐私、有限重试、竞态防护、依赖基线、benchmark 正确性和 Token-efficient 合成验收均已覆盖。
- Vitest 将文件级 workers 限制在 1～4，避免 Windows 高核机器并发创建过多 Git worktree/SQLite 造成假超时。
- 真实 Glue disposable 已完成两项施工：一项从保留分支恢复审查并合并，一项完整自动链一次通过；真实 Glue 的 3 个 L2 文件已在备份和 blob 对比后安全写回，17/17 精确测试通过。
- DeepSeek Flash 已确认的健康检查与完整自动链费用合计约 0.000484 + 0.025913 = 0.026397 元；首项施工发生在计量修复前，费用无法从截断日志恢复，必须单列为 unavailable。
- 每个真实 Pi 新会话先进入只读理解门，最多两轮“Pi 提问 → Codex 技术答疑”；需求选择、隐私、费用扩大或范围变化转用户决策。真实 disposable 冒烟已证明 2 个只读理解回合后才开放施工，未达到 95% 时不会修改。

若要对外宣称“比纯 Codex 省多少 Token”，仍须按照 `docs/REAL-PROVIDER-AB-RUNBOOK.md` 做 sequential baseline 对照；这不是私人使用的当前阻断项。

## 精简版说明

本目录从完整快照中移除了阶段性 handoff、旧施工契约、MySQL `_archive`、依赖、构建产物、Git 元数据和运行时隐私数据。完整现场保存在：

`D:\仓库集合\仓库1\codex-brain-pi-orchestrator-backup2\原始完整快照\codex-brain-pi-orchestrator`

## 本地准备

要求：

- Node.js 24.x（项目使用内置 `node:sqlite`）；
- Git；
- 仅在明确授权的真实测试阶段需要 Pi CLI 和 Codex CLI。

```powershell
cd "D:\仓库集合\仓库1\codex-brain-pi-orchestrator-backup2\精简可运行版"
npm ci
npm run build
npm test
```

不要在准备阶段设置或输出 API Key，不要复制原项目的 `.brainctl` 或 `.brainctl-dev`。

## 当前文档

- `docs/CURRENT-ISSUES.md`：当前仍存在的问题和投入使用阻断项。
- `docs/CONCURRENCY-WORK-PLAN.md`：PiAgent 施工批次、依赖和文件冲突边界。
- `docs/CONFIG.md`：项目配置和 CLI 配置说明。
- `docs/PROTOCOLS.md`：结构化协议和 Schema。
- `docs/SYSTEM-DESIGN.md`：仍有效的总体角色边界。
- `docs/REAL-RUN-READINESS.md`：重新定义的真实运行准入门槛。
- `docs/HANDOFF-2026-07-28-CANDIDATE-CLOSURE.md`：本轮候选版收口、验证证据与剩余边界。
- `docs/HANDOFF-2026-07-28-REAL-ACCEPTANCE.md`：真实 Provider 施工、修复、费用、写回与清理证据。
- `docs/HANDOFF-2026-07-29-BRIDGE-CLARIFICATION.md`：bridge 改名、95% 理解协议、Windows CLI 修复与真实验收。

## 安全边界

- 默认仍只允许 fake/disposable 验证；真实 Provider、网络与真实 Token 消耗需要显式授权。
- 不得把 paused、conflict、waiting_decision 或部分 approved 当作完成。
- 不得在未授权情况下清理 Git 历史、SQLite、日志或 worktree。
- 并发施工必须使用独立工作副本或 worktree，禁止多个 Agent 同时写同一目录。
- 对外效果宣称所需的 sequential A/B 必须单独授权并保留可核验计量。

## 目标

本阶段不追求开源或大规模商业通用性，只追求：

1. 私人 Windows 环境下能够相对稳定地运行长任务；
2. 失败能够有限终止、恢复且不误合并；
3. 默认不明文持久化敏感内容；
4. 相比直接由 Codex 全程施工，能够测量并减少 Codex Token 使用；
5. 不以增加大量失败重试或总成本为代价伪造“省 Token”。
