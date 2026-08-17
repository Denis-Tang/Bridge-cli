# 文档权威入口与历史索引

更新日期：2026-08-16（新增 Phase 0 freeze changelog；下方 2026-08-02 内容为历史快照，逐字保留）

本页解决“当前契约”和“历史施工证据”混读的问题。源码、数据库约束和当前测试结果优先于文档；历史报告中的测试数字、路径、已知问题和结论只描述当时快照，不能覆盖当前事实。

## 2026-08-16 Phase 0 freeze changelog

- **costBudget 无单位化（决策已拍板）**：保留 `limit` / `maxPiCallCost` / `maxCodexCallCost` 字段名，仅删除 `currency` 与 `pricingVersion`；数值解释为「无单位最坏单次调用配额」；README / CURRENT-ISSUES / CONFIG 当前段的「金额/成本」表述同步改为配额口径（历史快照段落逐字保留）。
- **Provider token 归属（决策已确认）**：`first Pi call`（input=24744 / output=12142 / cache-read=101760 / total=138646）↔ `run_1786815966018`（Pi commit `0099365`、最终 merge `c979832`）；`follow-up`（input=15134 / output=6103 / cache-read=152192 / total=173429）↔ `run_1786817596600`（Pi commit `a74fe7b`、最终 merge `ea1ad8e`）。
- **历史段落个人绝对路径（决策已确认）**：2026-08-02 历史段落原样保留（历史快照逐字保留）；仅新增 08-16 当前段落且避免出现新的个人绝对路径。
- **bootstrap 表述（决策已确认）**：`f4bb660` 记录为「4 文件、80 测试获批」，并注明其与 migration 015 legacy provenance 的关联（见 REAL-RUN-READINESS）。
- **当前 fake/disposable 全回归**：92/92 文件、1082/1082 测试通过；TypeScript build 与 `git diff --check` 通过；heartbeat 精确测试 1 文件 / 4 项连续三次最终 main 全回归通过。
- **真实 Provider 金额不可得**：两笔窄范围真实运行的 provider money cost 与 Codex 用量均 `unavailable`；不宣称零成本、不标注货币金额。
- **清理（Phase 0 freeze）**：已接纳的两笔真实 Provider run 的 task worktree 已回收；3 个旧 fake run worktree 保留 manual_review；失败的首个集成分支 `brainctl/int/run_1786815966018/stage-1/a1` 仍保留；未发生强制删除。
- **sequential A/B 仍未执行**；正式仓库回写 / tag / bundle / 生产成熟度未宣称。

## 当前权威文档

| 主题 | 唯一权威位置 | 边界 |
|---|---|---|
| 快速入口与安全边界 | `README.md` | 简洁使用说明，不复制易漂移测试数字 |
| 系统组件与运行闭环 | `docs/SYSTEM-DESIGN.md` | 架构、状态与 Review 边界 |
| 协议与状态证据 | `docs/PROTOCOLS.md` | JSON 协议、PauseRecord、provenance、actual-path claim |
| 项目与 Provider 配置 | `docs/CONFIG.md` | Node 24、SQLite、质量门、Dashboard、执行模式 |
| 当前未闭环风险 | `docs/CURRENT-ISSUES.md` | 只放仍然成立的风险，不重复历史关闭项 |
| 真实运行与本轮回归 | `docs/REAL-RUN-READINESS.md` | 区分历史真实 Provider 证据和当前 fake/disposable 回归 |
| Token-efficient 可审计契约 | `docs/TOKEN-EFFICIENT-CONTRACT.md` | 当前实现契约；`06-token-efficient-design.md` 仅为历史设计参考 |
| 真实 Provider A/B | `docs/REAL-PROVIDER-AB-PROTOCOL.md`、`REAL-PROVIDER-AB-RUNBOOK.md`、`REAL-PROVIDER-AB-RESULT-TEMPLATE.json` | 未执行；不授权调用，也不证明节省比例 |
| 长任务／恢复假验收设计 | `docs/LONG-TASK-FAKE-ACCEPTANCE.md`、`docs/RECOVERY-FAKE-ACCEPTANCE.md` | 场景设计与历史证据；当前总数以 REAL-RUN-READINESS 为准 |

## tracked HANDOFF 历史

以下 10 份文件全部由 Git 跟踪并保留原位，可从仓库历史恢复。它们是按日期冻结的施工／审查记录，不是当前配置或运行准入的权威来源。

| 文件 | 历史主题 |
|---|---|
| `HANDOFF-PRIVACY-MAINLINE.md` | 隐私主链接入与当时遗留风险 |
| `HANDOFF-BOUNDED-RETRY.md` | 有限重试与失败分类 |
| `HANDOFF-SAFE-CONFIG.md` | argv 质量门与便携配置 |
| `HANDOFF-ACCEPTANCE-RED-TEAM.md` | benchmark 红队阶段 |
| `HANDOFF-ATOMIC-CANCEL-INTEGRATION.md` | 取消／集成原子性阶段 |
| `HANDOFF-FINAL-FAKE-ACCEPTANCE.md` | 早期 fake 全量验收 |
| `HANDOFF-TOKEN-EFFICIENT.md` | Token-efficient 初次实现 |
| `HANDOFF-2026-07-28-CANDIDATE-CLOSURE.md` | 2026-07-28 候选版收口 |
| `HANDOFF-2026-07-28-REAL-ACCEPTANCE.md` | 2026-07-28 历史真实 disposable/Glue 证据 |
| `HANDOFF-2026-07-29-BRIDGE-CLARIFICATION.md` | 2026-07-29 95% 澄清门与真实冒烟证据 |

历史文件中出现的 `62/828`、`67/913`、`67/920`、`69/930` 等数字均保持原样用于审计。它们不是当前分支的测试总数，也不得被汇总成最新验收结果。

## 未执行的真实 A/B

真实 Provider A/B 协议、runbook 和 JSON 模板保留了完整可执行信息，但截至 2026-08-02 仍未执行同任务 sequential baseline。现有 fake benchmark 只能证明调度结构与调用次数变化；历史真实 Pi/Codex 运行也不能替代同输入、同验收标准的 A/B。因此没有真实 Codex token 降幅或固定节省比例结论。

## 保留但建议退役的资产

- 仓库根目录 `postcss.config.mjs` 当前未被 Git 跟踪且被 ignore，项目无 PostCSS 构建链引用。它已进入 `09-pre-refactor` 备份；本轮不移动、不删除，建议在用户单独确认后再处理。
- `docs/06-token-efficient-design.md` 保留为 2026-07-27 设计参考。其 Draft 假设和行号可能过时，当前行为以 `TOKEN-EFFICIENT-CONTRACT.md`、源码和测试为准。

