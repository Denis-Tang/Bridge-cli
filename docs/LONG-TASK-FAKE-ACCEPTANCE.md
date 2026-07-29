# Long Task Fake Acceptance — 长任务与同路径验收

更新日期：2026-07-28

## 结论

**PASS。** `tests/acceptance/long-task-stability.test.ts` 最终为 13/13，并从修正版连续独立运行三轮通过：

- 170,789ms；
- 169,415ms；
- 169,351ms。

所有测试只使用 fake Provider 与 disposable Git 仓库，不访问网络、不读取 `.env`，所有 Token 数据均为 `synthetic`。

## 覆盖范围

### 长任务稳定性

- 16 个任务、3 个阶段、DAG 扇出/扇入、多跳依赖；
- 每个 Worker 有真实 await 延迟，不用伪造 duration；
- 强断言 run/stage completed、16/16 task merged、目标分支逐文件正确、ledger callId 无重复；
- 两轮状态漂移检查均合并 16/16 任务。

### 同路径和依赖基线

- 无依赖的同路径写入被安全阻断，不会误报 completed；
- 有显式依赖的同路径后任务从前任务已批准结果开工；
- 调度器为每个 attempt 记录实际 diff base，普通执行和 resume 均按任务自己的基线计算 diff；
- 依赖文件不会被误判为当前任务越界修改。

### 失败、重试与清理

- 产品决策需求是不可重试失败：任务进入 `waiting_decision`，只创建 1 次 attempt；
- WorkerResult 缺失被规范为 `worker_result_missing:` 瞬态原因；当 `maxReworkCount=1` 时最多 2 次总 attempt，随后以 `retry_budget_exhausted: 2/2` 暂停，不合并、不完成 run；
- fixture 运行时数据库存在，teardown 后专属临时目录删除；
- paused、conflict、waiting_decision 均不能被 benchmark 判为成功。

## 关联验收

- recovery integrity：35/35；
- corrected benchmark：三轮完成率 100%，墙钟时间变异系数 1.1%；
- 最终 `npm run check`：67 个测试文件、913 项测试通过。

## 限制

1. 这是调度和状态语义的 fake/disposable 证据，不是实际 Pi/Codex 长任务。
2. 合成 Token 只能用于验证计量、预算和相对算法路径，不能证明真实 Token 节省。
3. 真实长期稳定性仍需用户授权后的 10—20 次长任务观测与故障注入。
4. 为避免 Windows 32 核机器同时创建过多 Git worktree/SQLite，`vitest.config.ts` 将文件级 workers 限制为 1～4；这不改变单个调度验收内部的并发语义。

## 运行命令

```powershell
npx vitest run tests/acceptance/long-task-stability.test.ts --silent
npx vitest run tests/acceptance/recovery-integrity.test.ts --silent
npm run check
```
