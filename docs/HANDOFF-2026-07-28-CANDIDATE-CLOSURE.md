# 2026-07-28 候选版收口交接

## 一句话结论

本目录已经从“审计后待返工”推进到“fake/disposable 验收通过的真实 A/B 候选版”：最终 `npm run check` 通过 67 个测试文件、913 项测试。真实 Pi/Codex 和真实 Token 效果仍未运行，必须由用户另行授权。

## 本轮完成

### 调度与恢复

- WorkerResult 缺失原因统一为 `worker_result_missing:`，接通瞬态失败的有限重试；预算耗尽后稳定暂停，不会无限创建 attempt。
- 依赖任务合入后记录 attempt 的实际 diff base；普通执行与 resume 均按任务自己的基线计算 diff，依赖文件不再被误判为越界。
- 长任务、同路径、产品决策、重试耗尽、状态漂移、恢复与 teardown 均有 artifact/state 断言。

### 隐私与配置

- 新增真实磁盘 `node:sqlite` + migrations 的隐私 artifact 泄漏验收，使用合成 canary 对 SQLite、日志和 artifact 做字节级扫描。
- minimal 禁止 raw prompt 持久化；debug 到期回退；legacy 可保留但不在展示面回显原文；teardown 只清理测试自有临时目录。
- `init --update` 配置 diff 中 `env` 对象的所有值统一显示为 `[REDACTED]`。
- 新增 `resolveProjectPath()`；相对路径没有显式可信基目录时 fail-closed，运行时入口和配置文件路径分别传入明确基目录。

### 测试资源控制

- `vitest.config.ts` 设置 `minWorkers: 1`、`maxWorkers: 4`。
- 原因是 Windows 32 核机器上测试文件同时创建大量 Git worktree/SQLite 会造成资源争用和假超时；单个调度验收内部并发仍照常覆盖。

## 验证证据

- 最终 `npm run check`：退出码 0，67 files / 913 tests PASS，总耗时 366,021ms。
- 完整长任务最终修正版连续三轮：13/13；170,789ms、169,415ms、169,351ms。
- recovery integrity：35/35。
- 新 privacy artifact leak：7/7，测试后 `brainctl-privacy-accept-*` 临时目录残留 0。
- 原有三组 privacy：95/95。
- 受影响范围回归：9 files / 125 tests。
- token benchmark：9/9；benchmark concurrency：8/8；token-efficient：22/22；M3：12/12；Token ledger v5：4/4。
- corrected benchmark 三轮完成率 100%，墙钟时间变异系数 1.1%。

## 修改范围

生产代码：

- `src/core/stage-scheduler.ts`
- `src/cli/commands/init.ts`
- `src/adapters/project-adapter.ts`
- `vitest.config.ts`

新增验收：

- `tests/acceptance/privacy-artifact-leak.test.ts`
- `tests/acceptance/helpers/privacy-fixtures.ts`

更新回归：

- `tests/acceptance/long-task-stability.test.ts`
- `tests/acceptance/helpers/long-task-fixtures.ts`
- `tests/cli/project-init.test.ts`
- `tests/core/project-config.test.ts`
- `tests/core/m3-adaptive-dispatch.test.ts`
- `tests/core/m4-token-ledger-v5.test.ts`
- `tests/core/benchmark-correctness.test.ts`
- `tests/acceptance/red-team-regression.test.ts`

## 未做与下一步

- 未读取 `.env`、Token、Cookie、私钥或真实 Provider 凭据。
- 未运行真实 Pi/Codex、网络或 Provider A/B。
- 未执行 Git stage、commit、push、reset、checkout 或 clean。
- 未删除 `node_modules`、`dist`、SQLite、原始快照或用户资料。
- synthetic Token 结果不能写成真实节省结论。

下一步只有在用户明确授权后，按照 `REAL-PROVIDER-AB-RUNBOOK.md` 使用一次性仓库执行至少三轮真实 A/B；正确性不下降且实测 Codex Token 下降，才允许宣称真实节省。
