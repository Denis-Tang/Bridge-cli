# 当前问题清单

更新日期：2026-07-29

本文件只记录当前仍未闭环的事项。2026-07-27 审计列出的隐私主链、环境最小化、有限重试、shell 策略、取消/合并竞态、依赖基线、benchmark 正确性和 Token-efficient fake 验收问题，已经完成代码修复并通过 fake/disposable 回归；详情见 `HANDOFF-2026-07-28-CANDIDATE-CLOSURE.md`。

## 当前阶段结论

- **私人基本稳定可用：PASS。** 最终 `npm run check` 通过 69 个测试文件、930 项测试；真实 DeepSeek Pi、自动 Codex 技术答疑、Codex 审查、质量门、scope、merge 和 cleanup 已在 disposable 上跑通。
- **95% 理解门：PASS。** 每个非注入真实 Pi 入口默认强制只读澄清；最多两轮答疑，受保护决策转用户，达到 95% 且无问题后才开放施工工具。真实冒烟完成 2 个只读回合、1 次 Codex 技术答疑后才修改目标文件。
- **真实业务施工：PASS。** Glue L2 窗口尺寸上限修复经 17/17 测试与真实 Codex 审查后写回真实工作树，且未覆盖用户原有 UI 改动。
- **sequential A/B：未执行。** 因此当前不宣称已经证明相对纯 Codex 的 Token 节省比例。

## 真实运行前仍需完成

### R1：补做 sequential baseline（非私人使用阻断）

真实 orchestrated candidate 已执行；若要量化节省效果，仍需按照 `REAL-PROVIDER-AB-RUNBOOK.md` 和 `REAL-PROVIDER-AB-PROTOCOL.md` 补做同任务、同输入、同验收标准的 sequential baseline。

必须同时报告：

- 最终文件与测试是否正确；
- Codex input/output/cache Token；
- Pi Token、total Token 和加权成本；
- 墙钟时间、重试率、失败率与恢复时间。

合成 benchmark 中的 Token 数据只能标记为 `synthetic`，不能作为真实节省结论。

### R2：积累更多真实长任务运行样本（增强项）

当前两项真实施工足以支持私人基本使用，但不等于长期生产成熟。若面向多人或长期无人值守，仍建议积累 10—20 次真实长任务观测和故障注入。

### R3：确定版本与历史数据治理策略

- Node 24 的 `node:sqlite` 仍可能输出 experimental warning，应固定运行时版本并记录升级策略。
- Git 历史邮箱、旧 SQLite、`.brainctl-dev`、nested `.git` 和历史运行产物是否清理，必须由用户另行决定；本轮没有删除。

## 非阻断增强

- 增加 Node 之外的 disposable fixture，例如 Python、混合构建或多质量门项目。
- 在真实样本形成后校准预算阈值、风险分级和 review 聚合策略。
- 继续观察 Windows 上大量 Git worktree 与 SQLite 并发的资源曲线；当前 Vitest 已限制为 1～4 个文件级 workers，避免测试进程过量并发造成假超时。
