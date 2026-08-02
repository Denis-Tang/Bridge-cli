# Bridge（CLI: `brainctl`）

Bridge 是一个本地长任务编排器：Codex 负责结构化规划和关键审查，Pi 在独立 Git worktree 中施工，SQLite 保存唯一任务状态。目标是在不降低质量门的前提下，把可委派施工从 Codex 转给 Pi，并通过阶段并发缩短长任务耗时。

> Bridge 已能验证“减少逐任务 Codex 审查调用”和“并发任务重叠执行”，但没有完成同任务真实 Provider sequential A/B，因此不宣称固定 Token 节省百分比。Pi Token 和总费用是可观测的代价与护栏。

## 工作方式

```mermaid
flowchart LR
    A["Codex 生成分阶段 DAG"] --> B["用户批准计划"]
    B --> C["Pi 只读理解门 >= 95%"]
    C --> D["同阶段可运行任务进入滚动并发池"]
    D --> E["任务范围检查 + 任务质量门"]
    E --> F["高风险/返工任务逐项 Codex 审查"]
    E --> G["低中风险任务聚合为阶段审查"]
    F --> H["阶段集成质量门"]
    G --> H
    H --> I["合并目标分支，进入下一阶段"]
```

- 阶段是严格屏障：阶段一全部通过、集成和合并后，阶段二才开始。
- 同阶段不是“一次开完所有 Pi 窗口再整批等待”：Scheduler 维持并发上限，任一任务结束就立刻补充新的依赖就绪任务。
- 返工仍使用新的 Pi 进程、新分支和新 worktree，但从上一有效 attempt 分支继续，只发送失败摘要、审查发现和累计 diff。
- 正式 Pi Provider 在施工前强制经过只读理解门；两轮技术答疑后仍低于 95%，或涉及需求、隐私、费用和范围选择时暂停给用户。

## 准备与验证

要求 Node.js 24.x（支持区间 `>=24.0.0 <25.0.0`）和 Git；真实施工另需已配置的 Pi CLI 和 Codex CLI。Bridge 不支持 Node 22，也不会在 doctor 中放宽该区间。

```powershell
npm ci
npm run check
npm run brainctl -- doctor
```

测试和 CI 只使用 fake Provider 或 disposable Git 夹具，不应消耗真实 Provider Token。

当前 fake/disposable 验收数字在每次最终全回归后写入 [docs/REAL-RUN-READINESS.md](docs/REAL-RUN-READINESS.md)；README 不复制可能漂移的中间数字。测试与 CI 不运行真实 Provider，也不构成 sequential A/B 证据。

## 五步使用

```powershell
# 1. 只读探测；加 --apply 才写项目配置
npm run brainctl -- init --project "C:\path\to\project"

# 2. 生成结构化计划（plan 是 submit 的别名）
npm run brainctl -- plan "实现一个分阶段需求" --project "C:\path\to\project"

# 3. 查看计划和状态；可用 --project 或 --db 明确定位状态库
npm run brainctl -- status <run-id> --project "C:\path\to\project"

# 4. 批准并执行（run 是 approve 的别名）
npm run brainctl -- run <run-id> --allow-real-project --db "C:\path\to\state.db"

# 5. 可选：启动本机只读状态台
npm run brainctl -- dashboard --run-id <run-id> --project "C:\path\to\project"
```

Dashboard 只允许绑定 `127.0.0.1`、`localhost` 或 `::1`，没有批准、取消、重试或写入 API。命令行仍是完整控制面。

## 执行模式

项目 `.brainctl/project.json` 默认：

```json
{
  "executionMode": "token-efficient"
}
```

- `token-efficient`：低/中风险首轮任务通过任务质量门后跳过逐任务 Codex 审查，在阶段集成时做一次聚合审查；高风险和返工任务仍逐项审查。
- `simple`：小任务的轻量模式，仍保留范围、质量门和必要审查升级。
- `default`：兼容模式，每个任务逐项审查。

可用 `--execution-mode default|simple|token-efficient` 显式覆盖。优先级为 CLI > run 配置快照 > 项目配置 > 安全默认值；`approve` 和 `resume` 会复用创建 run 时的脱敏快照。

## 金额预算与恢复

真实 Provider 运行必须在项目配置中提供 `costBudget`。Bridge 在每次真实 Pi/Codex 调用前，用 SQLite `BEGIN IMMEDIATE` 原子预留用户声明的最坏单次金额；缺少预算、账本不可用或余额不足都会在进程启动前暂停。Provider 没有返回可信金额时，整笔预留保留为 `usage_unknown/unavailable`，不会按 0 元继续。

这套账本是用户声明价格下的运行硬门，不是 Provider 官方账单。`status` 和 Dashboard 显示已确认、已预留、未知用量和剩余额度；真实账单仍以 Provider 为准。

### 孤儿 worktree / 分支回收（`brainctl gc`）

长时间运行、反复失败的场景会在 `.brainctl-dev/worktrees` 下积累孤儿 worktree 目录和 `brainctl/*` 分支。`gc` 是**默认只读**的盘点命令，让用户先看到积了多少，再显式决定回收：

```powershell
# 只读盘点：三类分类（可安全回收 / 需人工判断 / 不得触碰）+ 汇总
npm run brainctl -- gc --db "C:\path\to\state.db"

# 受约束回收：只处理现场复核通过的"可安全回收"条目
npm run brainctl -- gc --db "C:\path\to\state.db" --apply --decision-note "<原因>"
```

- **默认绝不删除任何东西**；不带 `--apply` 时纯只读。
- `--apply` 必须同时提供 `--decision-note`，否则 fail closed（退出码 1，不删除）。
- 只回收满足全部条件并**删除前现场逐条复核**的条目：在 worktrees 根内、对应 attempt 已终态、无未提交 tracked 改动、分支无未合并 commit。
- **硬护栏**：分支含未被目标分支吸收的 commit（`git merge-base --is-ancestor` 不成立）时一律归"需人工判断"并在报告中显著标注——这类分支可能承载已付费但尚未接纳的工作，删除后将无法用 `recover attempt` 接纳；`--apply` 不会碰它们。
- 回收方式：仍被 git 注册的走 `git worktree remove` 安全路径（脏则 git 自己拒绝）；已注销的残留目录优先送回收站，Windows 长路径失败时走短路径隔离区，最后才永久删除；每次回收写入 SQLite 审计事件（含 `--decision-note`）。
- **不自动回收**：`gc` 是用户显式发起的独立操作，不会挂到 paused/failed 路径自动执行，避免误删排障证据。

如果 Pi 已产生可验证提交，但结果协议、Reviewer 或后续流水线失败，不要重复付费启动 Pi。使用正式恢复命令先把现有成果接纳为 `worker_completed`：

```powershell
npm run brainctl -- recover attempt <attempt-id> `
  --commit <sha> `
  --worktree "C:\existing\clean-worktree" `
  --branch "brainctl/..." `
  --db "C:\path\to\state.db"

npm run brainctl -- status <run-id> --db "C:\path\to\state.db"
npm run brainctl -- resume <run-id> --confirm-pause <active-pause-id> `
  --allow-real-project --db "C:\path\to\state.db"
```

`recover attempt` 只接纳该任务的最新 attempt，并会重跑范围门、`git diff --check` 和任务质量门；这些外部校验通过前，SQLite 只读且不会应用迁移。若变更超出冻结的 TaskSpec 范围、但仍在 Run 保存的项目 `allowedPaths` 内，必须显式添加 `--allow-scope-expansion --decision-note "<原因>"`，原始 TaskSpec 不会被改写。接纳记录会绑定 commit、实际文件摘要、批准的扩展摘要和对应路径锁；后续 `resume` 会重新核对这些证据，只把精确批准的扩展加入本次有效范围。恢复不会把 Run 冒充为已完成，真实 Review、阶段集成和最终覆盖仍不可跳过。

## 质量门

Bridge 的完成条件不是 Worker 自报 PASS，而是证据链全部成立：

1. Pi 返回可解析的 `WorkerResult`，真实执行必须存在触及预计路径的 Git diff。
2. diff 必须通过 allowed/forbidden path 范围校验。
3. 每个任务必须通过项目定义的任务质量门；没有质量门会 fail closed。
4. 高风险、返工或异常任务必须通过逐任务审查；真实 Pi 只能搭配真实 `codex-cli` Reviewer，`local-rule` 仅用于 fake/disposable 路径。
5. 每个阶段的最终 integration commit 都必须通过聚合审查；token-efficient 不能跳过这道最终审查。
6. 合并后的集成 worktree 必须再次通过阶段质量门。
7. 目标分支不得在审查后漂移，最终 merge tree 必须与已审 integration tree 一致，才能记录 `reviewCoverageStatus=complete`。
8. 取消、预算、审批、锁、合并冲突和最终状态收敛检查必须全部允许合并。

质量门命令使用 argv 向量执行；Shell 只允许显式配置。详细配置见 [docs/CONFIG.md](docs/CONFIG.md)。

## 安全与项目边界

- 默认只允许 fake/disposable 验证；真实项目需要明确 `--allow-real-project`。
- 每个 attempt 使用独立 worktree，路径锁使用 SQLite 原子获取。
- `.env`、Token、Cookie、私钥和 Provider 原始输出不得进入仓库、快照或 Dashboard。
- `paused`、`waiting_decision`、`conflict`、部分 `approved` 都不是完成。
- 对外性能声明必须使用同任务 sequential baseline；合成数据必须标记 `synthetic`。

## 开源协作

项目采用 MIT License，并提供 Windows + Node 24 的 fake/disposable CI 基线。提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。当前面向用户的产品名称为 Bridge；`brainctl` 仅表示 CLI 可执行文件。

进一步设计与验收材料位于 `docs/`。权威文档和 10 份历史 HANDOFF 的定位见 [docs/HISTORY.md](docs/HISTORY.md)；其中 `TOKEN-EFFICIENT-CONTRACT.md`、`SYSTEM-DESIGN.md` 和 `REAL-PROVIDER-AB-RUNBOOK.md` 是最重要的边界文档。
