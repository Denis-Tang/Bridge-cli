# 真实运行准入状态

更新日期：2026-08-02

## 当前结论

**FAKE/DISPOSABLE PASS；CURRENT PRIVATE REAL-RUN REGRESSION PENDING；SEQUENTIAL A/B EFFECT CLAIM PENDING。**

当前实现已通过 Node 24.14、真实磁盘 SQLite、disposable Git、fake worker/reviewer 和 synthetic benchmark 的完整回归。本轮没有启动真实 Pi 或 Codex Provider，没有读取 `.env` 或凭据值，Provider 调用为 0、确认费用为 0。

2026-07-28 的真实 DeepSeek Pi + Codex CLI 结果保留为历史证据，但它早于本轮 PauseRecord、成本 reservation、actual-path claim/provenance、只读 Dashboard、澄清工具门和 scheduler 拆分，不能代替当前树的真实 Provider 回归。当前树只有在用户另行明确授权、设置预算并先通过 disposable 副本后，才能重新取得 PRIVATE REAL-RUN PASS。

## 2026-08-02 fake/disposable 全回归

以下命令均在 `C:\Users\29672\Documents\bridge` 执行，runner 全部为 fake/disposable/synthetic；测试文件总数为 82，合计 1016 项通过：

- `npm run build`：退出码 0。
- `npm test -- tests/state`：12 文件／151 项，退出码 0。
- `npm test -- tests/adapters tests/cli tests/e2e tests/git tests/privacy tests/quality tests/recorder tests/schemas tests/utils tests/privacy-mainline.test.ts`：31 文件／363 项，退出码 0。
- `npm test -- tests/core --exclude "tests/core/benchmark*.test.ts"`：31 文件／407 项，退出码 0。
- `npm test -- tests/acceptance`：4 文件／69 项，退出码 0，最终复跑 214.33 秒。
- `npm test -- tests/core/benchmark-concurrency.test.ts`：1 文件／10 项，退出码 0，197.43 秒。
- `npm test -- tests/core/benchmark-correctness.test.ts tests/core/benchmark-long-task.test.ts tests/core/benchmark-token.test.ts`：3 文件／16 项，退出码 0，159.42 秒。
- `git -c core.quotepath=false diff --check`：退出码 0。

首轮 acceptance 的唯一失败是旧测试仍匹配 Stage 6 之前的 `undeclared_same_path_conflict` 文本。生产路径当时已经正确在 worker spawn 前暂停；测试已改为断言不可变 PauseRecord 的 `declared_write_conflict_missing_dependency` 和 `declared_preventable` 事件层，精确复跑与完整 acceptance 均通过。生产状态机和冲突门没有放宽。

当前树不存在 `_archive` 测试目录或 `*.integration.test.ts`，因此 CLI `--exclude` 覆盖 Vitest config 的旧假失败假设不构成本轮门禁。

## disposable 场景证据

- pause → 精确确认 → ready → completed：`tests/cli/resume.test.ts` 的 4 项覆盖缺失、错误、过期和精确 `--confirm-pause <id>`；`tests/core/stage-pause-resume.test.ts` 的 7 项覆盖原子消费 PauseRecord、并发唯一解析和 `paused -> ready -> running -> integration -> completed`。合并执行 11/11 通过。
- stale cost reconcile：`tests/state/sqlite-cost-review-integrity.test.ts` 经 `runAutomaticReconciliation` 自动/CLI 共用路径把过期且 spawn/owner 状态未知的 reservation 保守结算为 `unavailable`，保留最坏成本，第二次执行 appliedCount 为 0；所在文件 9/9 通过。
- Dashboard 并行只读：`tests/core/dashboard-server.test.ts` 使用生产同型 `openReadonly` store，在 writable store 并行更新时连续 HTTP GET 成功并读到最新状态，POST 返回 405；`tests/state/sqlite-readonly-busy.test.ts` 另验证 query-only store 不改变数据库字节和 sidecar 集合，并对 busy timeout 分类。定向 Dashboard 1/1、SQLite 边界 2/2 通过。
- actual-path 冲突阻断：`tests/state/sqlite-stage6-integrity.test.ts` 5/5 覆盖同文件、父子路径、estimated/actual 交叉与并发唯一 owner；`tests/core/stage-scheduler.test.ts` 的 disposable Git 集成场景验证不同 hunk 写入同一文件仍暂停，PauseRecord reason 为 `runtime_undeclared_actual_path_conflict`，目标分支不前进。定向 6/6 通过。

## 当前安全与一致性契约

- Node 支持区间统一为 `>=24.0.0 <25.0.0`，README、doctor、engines 和 CI matrix 一致。
- SQLite writer 设置 busy timeout；Dashboard 使用 read-only/query-only 连接，仅允许 localhost，并且没有审批、重试、取消、恢复或配置写接口。
- 暂停必须创建不可变 PauseRecord；恢复要求精确 `--confirm-pause <id>`，错误、过期或缺失记录均 fail closed。
- Provider 调用先原子保留最坏成本；未知 money usage 不释放 reservation，过期 lease 只能保守 reconcile 为 unavailable。
- WorkerResult 保存不可变 provenance；实际写路径在任务后处理和 integration 前都必须取得 claim，冲突时暂停。
- default、simple 和 token-efficient 都必须对最终 integrated tree 做完整 Review；输入超过 bytes/lines 运维代理上限时标记 coverage incomplete 并暂停，不能截断后宣称 complete。
- Pi 0.82.1 的本机帮助和适配器代码确认澄清进程支持 `read,grep,find,ls` 原生 allowlist，并有 pre-tool-call guard；本轮未真实调用 Pi，真实 CLI 行为仍属于下一次授权运行的观察项。

## 2026-07-28 历史真实证据

旧候选曾记录 DeepSeek Flash 完整自动链 257,814 total tokens、0.003455004 USD，健康检查 442 tokens、0.00006454 USD；首项真实施工发生在计量修复前，费用不可恢复并标记 unavailable。Codex CLI 当时没有结构化 token 回传。旧回归为 67 文件／920 项，Glue disposable 自动链为 7/7 阶段。

这些数字只说明旧候选在当时的环境和代码上运行过，不是 2026-08-02 当前树的真实回归结果，也不能证明 Token 节省比例。原始历史入口见 `HANDOFF-2026-07-28-CANDIDATE-CLOSURE.md` 和 `HISTORY.md`。

## sequential A/B 效果声明门

若要宣称相对纯 Codex 的节省比例，必须由用户另行明确授权、设置成本上限并使用一次性仓库，按照 `REAL-PROVIDER-AB-RUNBOOK.md` 完成同任务 sequential baseline 与 orchestrated candidate：

1. 最终文件、测试、run、stage、task、attempt 和目标分支均正确；
2. 不把 paused、conflict、waiting_decision、部分 approved 或 incomplete review coverage 当作完成；
3. 正确性不低于 baseline；
4. 使用 Provider 可核验数据，不把 bytes/lines、Worker 自报或 synthetic token 当作真实 token；
5. 没有通过增加大量 Pi token、失败重试或未计量成本伪造收益；
6. 报告原始计量、失败、恢复和未计量项。

在这些条件完成前，当前版本只能称为“fake/disposable 全回归通过”，不能称为“当前私人真实运行通过版”或“已证明节省 X% Token 的 A/B 发布版”。
