# 当前问题清单

更新日期：2026-08-02

本文件只记录当前仍未闭环的事项。历史已关闭问题和旧测试数字见 `HISTORY.md` 与对应 HANDOFF；本轮最终 fake/disposable 数字只在 `REAL-RUN-READINESS.md` 记录。

## 当前阶段结论

- **P0/P1 可靠性修复：fake/disposable 已闭环。** PauseRecord 精确恢复、金额预留、SQLite 只读/忙等待、Windows 进程树终止、reconcile、不可变 provenance、actual-path claim、迁移事务、状态 CAS、Pi 澄清只读强制和最终 integrated-tree Review 均有回归覆盖。
- **历史私人真实运行证据：保留。** 2026-07-28/29 曾在 disposable 与明确授权范围内完成真实 DeepSeek Pi、Codex 技术答疑/审查和 Glue 定向施工；这些证据不自动覆盖 2026-08-02 之后的代码变更。
- **当前分支最终验收：仅 fake/disposable。** 本轮不调用真实 Pi/Codex，不读取凭据，也不把历史 Provider PASS 冒充当前真实回归。
- **sequential A/B：未执行。** 没有同任务真实 Codex token 数据，也没有固定节省比例结论。

## 仍需完成

### R1：补做 sequential baseline（非私人使用阻断）

若要量化节省效果，必须在用户另行明确授权和金额预算硬门下，按照 `REAL-PROVIDER-AB-RUNBOOK.md` 与 `REAL-PROVIDER-AB-PROTOCOL.md` 使用一次性仓库执行同任务、同输入、同验收标准的 sequential baseline。

必须同时报告正确性、Codex/Pi 原始计量状态、总成本、墙钟时间、重试/失败率和恢复时间。`synthetic`、`estimated`、字节数或行数代理均不能替代真实 Provider token。

### R2：积累真实长任务和故障样本

历史真实样本支持私人试用，不等于长期无人值守成熟。仍缺少 10—20 次长任务样本、长时 soak、系统重启/断电、WAL 损坏、磁盘满、杀毒软件锁文件和大量 worktree 并发压力下的真实证据。

### R3：Node 24 升级策略

Bridge 的唯一运行时区间已收敛为 `>=24.0.0 <25.0.0`：package engines、doctor、README 和 CI 一致，CI 只跑 Node 24。`node:sqlite` 仍可能输出 experimental warning；升级到 Node 25 或更高版本必须先在新分支验证只读打开、busy timeout、migration、WAL 和全回归，再显式修改支持区间，不能自动放宽 doctor。

### R4：Pi 澄清只读能力版本依赖 — 已有运行时自检强制保障（2026-08-02 第 3 轮）

当前依赖已验证的 Pi CLI 0.82.1 原生 `--tools read,grep,find,ls` allowlist，并叠加一次性 pre-execution path guard。升级 Pi CLI 时必须重新核对参数和 `tool_call`/`tool_execution_start` 事件语义；若无法在工具执行前阻断，澄清门必须 fail closed。

**现状（第 3 轮）**：每个真实 Pi 澄清会话前（每 run/每版本缓存一次）执行零推理 guard 自检（`pi-guard-selfcheck.ts`）：探针扩展的模块加载 marker、`pi.on('tool_call')` 注册 marker、`session_start` 事件 marker，任一缺失即 fail closed（拒绝启动澄清会话并暂停，不降级为仅第二层）。版本漂移（`worker.verifiedPiVersion` 默认 0.82.1）输出显著警告但不直接拒绝——探针必须通过。结果写入 `pi_guard_selfcheck` 事件（类别/版本/时长/stderr SHA-256，不存原文），`brainctl status` 可见。

**剩余边界**：
- 自检证明"扩展被加载 + handler 已注册 + 事件系统存活"，**不等于穷尽所有绕过路径**。
- 端到端阻断验证（B）已实施（`pi-guard-block-probe.ts` + `pi_guard_probe_cache` 持久化缓存 + 成本预留硬门 + 失败分类处置）：代码与 fake 测试完成（87/1063 全绿），**首次真实推理探针未执行**——按授权条件，真实发起前需用户显式同意（agent 会停下说明即将发起一次 ¥X 的推理探针）。
- B 的账目结算已改为**证据驱动**：真实 Provider 用量（非零 token/cost）硬否决 `released`；只有"确定未发出"（连接阶段失败/零输出字节+认证余额错误）才 `released`；429/5xx/upstream/响应内 timeout 一律保守 `unavailable`。

### G3：integrate() 幂等入口 — 崩溃重启不重复支付阶段审查（2026-08-02 第 4 轮）

原缺口：`integrate()` 每次进入都新建 batch；若进程在"batch 已 completed、stage 仍 integration"之间崩溃（SIGKILL/断电），重启会重跑集成——**阶段 Codex 审查是真实付费调用，崩溃一次重复付一次**。

现状：`integrate()` 入口新增幂等判定（`stage-integration.ts` `checkIdempotentIntegration` + `completeIdempotentIntegration`）：该 stage 存在 `completed` batch（取 createdAt 最新）+ `targetMergeCommit` 非空 + `reviewCoverageStatus='complete'` + `reviewerUnavailable=false` + **git 实证**（`isBranchMerged(commit, targetBranch)`，target 取自既有解析逻辑，非 HEAD）→ 跳过步骤 1-4（不新建 batch、不重跑质量门、**不重跑阶段审查**），只补齐步骤 5-9（任务 merged / stage completed / 释放 claims / `stage_completed` 事件带 `reason:'idempotent_resume'` / 残留 worktree+分支清理）。git 实证失败 → fail closed（`recordStagePause` reasonCode `integration_state_inconsistent`，交人判断，不静默重跑）。部分任务已 merged（崩溃于步骤 5 中段）可恢复：已 merged 任务 `updateTaskStatus` 返回 false 是终态保护的预期行为，未 merged 任务必须真更新成功。

**保留边界**：幂等入口只覆盖"batch-completed 之后"的崩溃点；更早的崩溃点（batch 未 completed）仍走完整重试，这是预期行为（集成尚未真正完成）。正常首次集成 / merge_blocked / paused 恢复路径行为未变（测试 9 回归护栏）。

### R5：最终 Review 运维代理上限

最终 integrated-tree Review 输入不截断。超过 524,288 UTF-8 bytes 或 20,000 lines 时不启动 Reviewer、coverage 保持 `partial` 并暂停 Stage。这两个值只是运维字节/行代理，不是 token 限额；超大变更需要拆 Stage 或在后续版本引入可证明完整覆盖的分片协议。

## 非阻断增强

- 增加 Python、混合构建和多质量门 disposable fixture。
- 在真实样本形成后校准金额预算、风险分级和 Review 聚合策略。
- 继续观察 Windows 上大量 Git worktree 与 SQLite 并发的资源曲线；Vitest 文件级 workers 保持有界，避免把资源争用误判为产品失败。

## 已闭环（2026-08-02 第 1 轮）

### G1：worktree / 分支孤儿泄漏 — 已提供显式回收路径（人工发起）

原缺口：`cleanupMergedStageWorktrees` 只在 Stage 成功合并后调用，paused/failed/SIGKILL 路径残留的 `.brainctl-dev/worktrees` 目录与 `brainctl/*` 分支无任何回收路径。

现状：新增 `brainctl gc`（`src/core/gc-service.ts` + `src/cli/commands/gc.ts`）：

- **默认只读盘点**：按"可安全回收 / 需人工判断 / 不得触碰 / 注册残留"四类分类，报告路径、分支、run/stage/task/attempt、状态、磁盘字节、修改时间与理由。
- **受约束回收**：`gc --apply --decision-note "<原因>"` 只回收删除前现场逐条复核通过的"可安全回收"条目；仍注册的走 `git worktree remove` 安全路径，已注销残留目录回收站优先（Windows 长路径失败时短路径隔离区，最后永久删除）；每次回收写 `gc_recycled` 审计事件（含决策理由与删除方式）。
- **硬护栏**：分支含未被目标分支吸收的 commit 时一律"需人工判断"并显著标注"含未合并的已付费提交"——防止删除可经 `recover attempt` 接纳的已付费工作。脏 worktree、非终态 attempt、越界路径一律拒绝。
- 测试：`tests/core/gc-service.test.ts` 10 个用例（含未合并 commit 护栏、现场二次校验、越界拒绝、脏 worktree 拒绝、缺 `--decision-note` fail-closed、已注销残留目录回收）。

**当前边界**：回收仍是**人工显式发起**（`gc --apply`），不会挂到 paused/failed 路径自动执行；已注册的孤儿 worktree 若被 git 拒绝（脏/未合并）会保留并归"需人工判断"，需要用户手动处理。

### G2：成本预留生命周期缺口 — 心跳已接入，unavailable 有人工核销出口（2026-08-02 第 2 轮）

原缺口：`heartbeatCostReservation` 零生产调用点，lease 一次性设置，长调用会被陈旧回收器误判；SIGKILL 后 `spawned` 预留永久停在 `unavailable` 占用预算且无核销出口。

现状：

- **心跳已接入**：Pi worker（`onProcessSpawn`）与 Codex reviewer（task review / stage review）执行期间按 lease 窗口 1/3 周期续期 `lease_expires_at`/`heartbeat_at`；定时器在所有退出路径（成功/异常/超时/取消）经 `finally` 清理并 `unref`，不残留阻止进程退出的句柄；心跳写库失败只记录不改变业务语义（`src/core/cost-heartbeat.ts`）。
- **人工核销**：`brainctl budget write-off --reservation <id> --decision-note "<原因>"`，只接受 `unavailable`（`reserved`/`spawned` 拒绝），必填决策理由，写 `cost_reservation_written_off` 审计事件（金额/理由/时间）；新终态 `written_off`（迁移 `013_cost_written_off.sql` 重建表加 CHECK 值）与 `released` 在查询中可区分。核销后 remaining 恢复。
- **只读盘点**：`brainctl budget list --status unavailable`（先看后销，与 `gc` 同一范式）。
- **可观测性**：`brainctl status` 与 Dashboard 成本区块按 reserved / spawned / unavailable / written_off / settled 分列显示（Dashboard 仅走既有只读查询路径，无写端点）。
- 测试：`tests/state/sqlite-cost-writeoff.test.ts`（T4-T7）+ `tests/core/cost-heartbeat.test.ts`（T1-T3），含"回收器证据标准未放宽"回归护栏（T7）。

**当前边界**：核销是**人工、显式、可审计**操作，绝不做成自动；`written_off` 的账目语义是"可能花了钱但用户决定不再占用额度"，不是"证明没花钱"（后者是 `released`）。回收器标准未放宽：`spawned_at != null` 时即使 lease 过期+owner 终态也只标 `unavailable`，不自动 `released`。
