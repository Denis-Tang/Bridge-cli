# 当前问题清单

更新日期：2026-08-16（Phase 0 freeze 补充；下方 2026-08-02 内容为历史快照，逐字保留）

本文件只记录当前仍未闭环的事项。历史已关闭问题和旧测试数字见 `HISTORY.md` 与对应 HANDOFF；本轮最终 fake/disposable 数字只在 `REAL-RUN-READINESS.md` 记录。

## 2026-08-16 Phase 0 freeze 补充（当前）

- **costBudget 无单位配额口径（已拍板）**：保留 `limit` / `maxPiCallCost` / `maxCodexCallCost` 字段名，仅删除 `currency` 与 `pricingVersion`；数值解释为「无单位最坏单次调用配额」，不再是金额。README / CONFIG 与本文件当前段的「金额/成本」表述已同步改为配额口径；历史快照段落逐字保留。
- **真实 Provider 运行金额不可得**：`run_1786815966018` 与 `run_1786817596600` 的 provider money cost 均 `unavailable`；Codex plan / clarification / review 用量均 `unavailable`。不宣称零成本，也不标注任何货币金额。
- **Provider token 归属已确认**：`first Pi call`（input=24744 / output=12142 / cache-read=101760 / total=138646）↔ `run_1786815966018`（Pi commit `0099365`、最终 merge `c979832`）；`follow-up`（input=15134 / output=6103 / cache-read=152192 / total=173429）↔ `run_1786817596600`（Pi commit `a74fe7b`、最终 merge `ea1ad8e`）。
- **sequential A/B 仍未执行**（见下方 R1）。
- **清理状态（Phase 0 freeze）**：已接纳的两笔真实 Provider run 的 task worktree 已回收；3 个旧 fake run worktree 保留在 manual_review；失败的首个集成分支 `brainctl/int/run_1786815966018/stage-1/a1` 仍保留；未发生强制删除（gc `--apply` 未执行）。
- **bootstrap 证据**：`f4bb660` 记录为「4 文件、80 测试获批」，其与 migration 015 legacy provenance 的关联见 REAL-RUN-READINESS。
- **不宣称**：正式仓库回写、tag/bundle 完成、生产成熟度或固定 Token 节省。

## 历史快照（2026-08-02，逐字保留）

### 当前阶段结论

- **P0/P1 可靠性修复：fake/disposable 已闭环。** PauseRecord 精确恢复、金额预留、SQLite 只读/忙等待、Windows 进程树终止、reconcile、不可变 provenance、actual-path claim、迁移事务、状态 CAS、Pi 澄清只读强制和最终 integrated-tree Review 均有回归覆盖。
- **历史私人真实运行证据：保留。** 2026-07-28/29 曾在 disposable 与明确授权范围内完成真实 DeepSeek Pi、Codex 技术答疑/审查和 Glue 定向施工；这些证据不自动覆盖 2026-08-02 之后的代码变更。
- **当前分支最终验收：仅 fake/disposable。** 本轮不调用真实 Pi/Codex，不读取凭据，也不把历史 Provider PASS 冒充当前真实回归。
- **sequential A/B：未执行。** 没有同任务真实 Codex token 数据，也没有固定节省比例结论。

### 仍需完成

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

### 非阻断增强

- 增加 Python、混合构建和多质量门 disposable fixture。
- 在真实样本形成后校准金额预算、风险分级和 Review 聚合策略。
- 继续观察 Windows 上大量 Git worktree 与 SQLite 并发的资源曲线；Vitest 文件级 workers 保持有界，避免把资源争用误判为产品失败。

### 已闭环（2026-08-02 第 1 轮）

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

## 已闭环（施工 02：Pi 提交与 WorkerResult 回传可靠性）

> 目标：根治「Pi 写对了代码、也提交了，但 WorkerResult/commitHash 没被系统拿到 → 每次靠人补 bootstrap commit」的头号病根。只改 disposable-target；不破坏 `Never faking Pi completion` 红线。

### C1：commitHash 回传契约收紧 + 解析/取证边界

- **Schema 收紧**（`src/schemas/worker-result.schema.json`）：`status=completed` 时 `commitHash` 必填且非空（`if/then` 条件约束）；非 completed 状态仍允许省略。
- **Prompt 契约**（`src/adapters/pi-worker-prompt.ts` 规则 6）：`commitHash` 必须等于 Pi 在 worktree 中实际提交的 commit 的完整 hash（`git rev-parse HEAD` 输出）；`status=completed` 时禁止占位符/示例值/随机串，系统会用 worktree HEAD 校验。
- **解析稳健性**（`pi-worker-result-parser.ts` / `pi-rpc-worker.ts`）：
  - 多种输出形态（纯文本标记块、代码块包裹、JSONL 事件、`agent_end` 早停）下 commitHash 均能解析，且与 worktree HEAD 一致（有测试证明）。
  - 早期检测不再让「不含 commitHash 的片段」抢占/丢弃后面含 commitHash 的完整结果（MarkedTextAccumulator 消费已返回块 + schema 拒绝不完整结果）。
  - 新增 `extractWorkerResultObject` 宽松提取，供取证路径在 commitHash 空串/缺失但 status=completed 时从 worktree HEAD 取证。

### C2：Pi 已提交但 WorkerResult 丢失 → 自动取证接纳（完全自动，无需人工确认）

- 新增 `recover.ts::autoAdoptVerifiableCommitEvidence`：当 attempt 是 `worker_completed`/`rework_required`（以及调度器实时路径的 `running`）但 WorkerResult 缺失、而 worktree 存在「可验证」commit（满足：`git merge-base --is-ancestor baseCommit commit`、worktree 干净、HEAD==commit、changed files 触及预计路径、provenance 匹配）时，**自动**走与 `recover attempt --commit <sha>` 完全相同的 provenance/scope/claim/质量门校验后接纳，来源记 `worker_auto_recovery`，打印「已自动取证并接纳候选 commit <sha>，来源=worktree HEAD 可验证证据」。
- **红线不破**：自动接纳不自动 merge、不跳过 reviewer——接纳后仍走正常 review → integration → merge（merge 仍在审查门后）；scope 扩展需要显式决策，自动路径绝不 auto-approve（fail closed）。
- 调度器接线：`execTask` 的 `!wrResult` 分支与 `resumeFromWorkerCompleted` 的 WorkerResult 缺失分支先尝试自动取证接纳，失败才走原 fail-closed（`worker_result_missing` / `worker_result_missing_recovery_available`）。
- 测试：`tests/cli/recover-auto.test.ts`（4 例：可验证提交自动接纳 / 未提交 fail closed / 脏 worktree fail closed / scope 扩展 fail closed）+ `tests/acceptance/auto-evidence-adoption.test.ts`（2 例调度器端到端）+ parser/RPC worker 新增用例。

**当前边界**：自动取证接纳要求 worktree 完整可验证（干净、HEAD 为 base 后代、变更触及预计路径、质量门通过）；任何一环不满足即 fail closed，绝不伪造 Pi 完成。

## 已闭环（施工 03：构建与预检固化）

### B1：`.sql` 复制进构建（tsc 不复制）

- 新增 `scripts/copy-sql-migrations.mjs` 作为 `postbuild`：把 `src/state/migrations/sqlite/*.sql` 复制到 `dist/state/migrations/sqlite/`，**校验数量 == 15**，缺则构建失败。
- `npm run build` 一条命令产出「可直接 `node dist/cli/brainctl.js` 运行」的完整 dist（含 15 个 `.sql`）。

### B2：doctor 预检强化（保持只读、退出码语义不变）

- 版本阈值：Pi CLI 需匹配已验证版本（默认 `0.82.1`，偏离给显著警告）；Codex CLI 需 `>=0.140.0`（CONFIG.md）。
- 配对检查：`real-pi` 必须配对 `codex-cli` 审查（`local-rule` 仅 fake/disposable），违反给失败提示。
- costBudget 检查：真实 Provider（`real-pi` 或 `codex-cli`）需要 `limit/maxPiCallCost/maxCodexCallCost` 完整，缺失/非法时明确提示「真实调用前必须补齐」（不直接拒绝）。
- dist 完整性：`dist/state/migrations/sqlite/*.sql` 数量与 src 一致（15），不一致提示重新构建。

### B3：integration worktree 依赖竞态正道化

- 新增 `src/core/int-deps.ts`（`prepareIntWorktreeDeps`）+ `StageIntegrationConfig.prepareIntDeps` 钩子：integration worktree 建好后、stage 质量门运行前，把 worktree 的 `node_modules` junction/符号链接到 **run 本地依赖副本**（`.brainctl-dev/int-deps/<runId>/node_modules`，hardlink 优先），绝不指向主仓库 node_modules（避免 merge 后 worktree 清理连带清空主仓库依赖——阶段 0 实测教训）。
- 运行方式统一：`node dist/cli/brainctl.js`（不用 tsx/esbuild）、vitest `--pool=threads`（避免 fork 命名管道 EPERM）、受限环境 `git archive` 替代 clone。
