# 真实运行准入状态

更新日期：2026-07-28

## 当前结论

**PRIVATE REAL RUN PASS；SEQUENTIAL A/B EFFECT CLAIM PENDING。**

实现已经通过 fake Provider、真实磁盘 SQLite、disposable Git 和真实 DeepSeek Pi + Codex CLI 验收。最终 `npm run check` 退出码为 0，共 67 个测试文件、920 项测试通过。

本轮未读取 `.env` 或凭据值。真实完整自动链记录到 DeepSeek Flash 257,814 total tokens、0.003455004 USD；健康检查为 442 tokens、0.00006454 USD。首项真实施工发生在计量修复前，费用不可恢复，已明确标记 unavailable。Codex CLI 没有结构化 token 回传，不能用自报或估算替代。

## 已关闭的旧阻断

2026-07-27 审计中的下列阻断已完成修复并纳入回归：

- minimal/profile/crypto 隐私主链与磁盘 canary 验收；
- Provider 与质量门子进程环境最小化；
- attempt/rework 有限重试和预算耗尽终止；
- 参数向量质量门与 shell fail-closed 策略；
- cancel、review、integrate 和 target merge 的竞态防护；
- 同路径依赖任务的实际基线与 diff base；
- benchmark 对 completed、目标分支和依赖完成时间的正确性判断；
- Token-efficient 调度、计量和 synthetic baseline 对比；
- 配置路径 fail-closed 与 `init --update` diff 脱敏。

详细代码和测试证据见 `HANDOFF-2026-07-28-CANDIDATE-CLOSURE.md`。

## fake/disposable 验收结果

- 最终全量：67 files / 920 tests PASS，构建通过。
- 完整长任务：13/13，最终修正版连续三轮独立通过，总耗时分别为 170,789ms、169,415ms、169,351ms。
- 恢复完整性：35/35。
- 新隐私 artifact 泄漏验收：7/7；测试结束后专属临时目录残留为 0。
- 原有三组隐私回归：95/95。
- 受影响范围回归：9 files / 125 tests PASS。
- corrected benchmark 三轮完成率 100%，墙钟时间变异系数 1.1%。
- Vitest 文件级并发限制为最少 1、最多 4 workers，降低 Windows 32 核机器上大量 Git worktree/SQLite 同时创建造成的假超时风险。

## 已完成的真实准入

- Provider 环境按模型收窄：DeepSeek Pi 只接收 DeepSeek key，Codex 不接收 Provider API key。
- Pi JSONL 用量从 Provider 事件提取；ledger 不再信任 Worker 自报。
- Pi/Codex 日志不保存原始 Provider 输出、原始 diff 或完整提示词；真实 Pi 只记录提示词长度和 SHA-256。
- Codex 默认使用 ephemeral + read-only + ignore-user-config/rules；真实审查通过。
- Windows Corepack pnpm 质量门、长路径 worktree 清理均有真实故障与回归覆盖。
- Glue disposable 完整自动链 7/7 阶段通过并清理分支/worktree。

## sequential A/B 效果声明门

若要宣称相对纯 Codex 的节省比例，仍需用户明确授权，并必须使用一次性仓库。按照 `REAL-PROVIDER-AB-RUNBOOK.md` 执行 sequential baseline 与 orchestrated candidate 对照，且满足：

1. 最终文件、测试、run、stage、task、attempt 和目标分支均正确；
2. 没有把 paused、conflict、waiting_decision 或部分 approved 当作完成；
3. 正确性不低于 baseline；
4. 实测 Codex Token 下降，且没有通过增加大量 Pi Token、失败重试或总成本伪造收益；
5. 报告原始计量、失败与恢复证据，不把 synthetic 数据混入真实结果。

在这些条件完成前，可以称为“私人真实运行通过版”，不能称为“已证明节省 X% Token 的 A/B 发布版”。
