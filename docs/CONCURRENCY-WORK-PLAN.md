# PiAgent 并发施工计划

目标模型：DeepSeek V4 Pro  
目标项目：`C:\path\to\backup-project`

## 基本规则

- 每个 PiAgent 使用独立工作副本或 Git worktree；不能在同一目录并发写文件。
- 每个 Agent 只修改提示词声明的文件边界。
- 不调用真实 Pi/Codex，不访问网络，不读取 `.env` 或输出凭据。
- 不删除用户数据，不改写 Git 历史，不提交/推送，除非用户另行授权。
- 每个 Agent 先写失败测试，再实现，再运行定向测试；输出 handoff 和实际命令结果。
- 施工窗口的自报 PASS 不等于独立验收。

## 批次 A：可并发

| 提示词 | 主要范围 | 与其他任务关系 |
|---|---|---|
| 01 隐私主链 | `src/privacy/**`、Pi/Codex adapters、隐私集成测试、加密持久化 | 独立副本施工；避免修改 `stage-scheduler.ts` |
| 02 有限重试 | `stage-scheduler.ts`、重试专项测试 | 不修改 adapters/quality/config；可与 01/03/04 并行 |
| 03 shell 与配置 | `src/quality/**`、project adapter/init/schema、相关测试 | 不修改 scheduler/privacy；可并行 |
| 04 benchmark 红队重写 | benchmark/acceptance tests 和测试 helper | 原则上不修改 `src/**`；可并行 |

批次 A 的结果必须由集成窗口逐个移植/合并；遇到同文件冲突时不得机械覆盖。

## 批次 B：批次 A 合并后执行

提示词 05：取消、merge lease、同路径集成和状态收敛。该任务会集中修改 scheduler、cancel、Codex process lifecycle、StateStore/migration，因此不能与 01/02 同时修改同一基线。

## 批次 C：批次 B 通过后执行

提示词 06：Token-efficient 执行模式。它会调整 Codex review 的粒度、增量上下文、cache 和 ledger，因此必须建立在稳定的重试/取消/集成语义上。

## 批次 D：所有源码施工完成后执行

提示词 07：集成验收与回归加固。默认不得修改 `src/**`；发现失败时只出具证据和返工清单，不能为了全绿降低断言。

随后把精简版交给 `交接文档\bridge\并发1\审查1` 中的独立审查提示词。只有独立审查 PASS，才可请求用户授权真实 Provider A/B。
