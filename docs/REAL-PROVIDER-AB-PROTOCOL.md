# Real Provider A/B Protocol

版本 1.0.1 | 状态：DRAFT／截至 2026-08-02 未执行（未经用户授权，不得执行）

## 1. 目的

本协议定义 disposable Pi/Codex Provider 真实 A/B 测试的完整流程。三个模式（sequential baseline / default orchestrated / token-efficient）使用完全相同任务集和验收标准，测定正确性、Token 效率与稳定性差异。

**关键约束**：本协议自身不授权任何真实 Provider 调用。所有真实 A/B 必须在用户明确授权后、在一次性 disposable 仓库中执行。

截至 2026-08-02，没有同任务 sequential baseline、没有当前真实 Codex token 数据、也没有固定节省比例结论。历史 fake benchmark 与零散真实运行都不能填充本协议的结果模板。

## 2. 前置门（Pre-Gates）

以下条件**全部**满足后，才可进入真实 A/B 准备阶段：

| # | 条件 | 当前状态 |
|---|------|----------|
| G1 | 当前独立审查明确允许进入真实 A/B | 必须在执行前重新确认；历史报告不自动授权 |
| G2 | 当前 commit 的 fake 长任务/同路径/写入收敛验收全部通过 | 必须使用 `REAL-RUN-READINESS.md` 的最新证据重新确认 |
| G3 | 用户明确口头或书面授权："授权执行真实 disposable Provider A/B" | 未获得 |
| G4 | disposable 仓库已创建，不含真实项目凭据或敏感数据 | 未创建 |
| G5 | 在冻结的 A/B commit 上按协议要求完成新鲜回归 | 未为 A/B 执行；普通开发回归不能代替该门 |

任何 G1-G5 未满足，A/B 准备和执行为 **BLOCKED**。

## 3. 固定参数（Immutable Parameters）

一旦进入 A/B 执行，以下参数在整个三模式九轮（及以上）中不得变更：

### 3.1 任务集（Task Set）

必须从项目 `tests/` 或预设固定 fixture 中选取封闭任务集。任务数量、内容、依赖关系、预期输出完全固定。任务指纹（`taskFingerprint`）是对任务列表稳定序列化后的 SHA-256 hex。

```text
taskFingerprint = SHA-256(稳定排序的 [taskId, inputHash, expectedOutputHash, dependencies] 数组)
```

### 3.2 目标分支（Target Branch）

固定一个 Git 分支名（如 `ab-target`），所有模式均合并到同一分支。分支在每轮开始前重置为相同基础 commit。

### 3.3 质量门（Quality Gate）

固定 quality gate 配置（规则集、阈值、审批逻辑）。质量门指纹（`qualityGateFingerprint`）是对配置稳定序列化后的 SHA-256 hex。

### 3.4 模型与 Provider 版本

| 参数 | 固定值 | 说明 |
|------|--------|------|
| 模型 | 待用户指定 | 如 `qwen/qwen3.7-plus:high` |
| Pi Provider 版本 | 锁定 package version + node version | 从 `package.json` + `node --version` 提取 |
| Codex Provider 版本 | 锁定 API version / SDK version | 从 lockfile 或 API 响应提取 |
| 环境类型 | `disposable` | 必须为 disposable，不可指向生产或开发环境 |

### 3.5 输入

所有模式的初始输入（prompt、上下文文件、工作目录状态）完全相同。

## 4. 三模式定义

### Mode 1：Sequential Baseline（顺序基准）

- 每个任务严格顺序执行，无并发、无编排。
- 不使用 stage 聚合、cache、resume 或 adaptive dispatch。
- 仅作为 Codex/Pi 原始调用的 baseline。

### Mode 2：Default Orchestrated（默认编排）

- 使用项目默认编排配置（`execution-mode`、`stage-scheduler`、`bounded-retry` 等全部启用）。
- 使用默认 cache 策略。
- 反映项目开箱即用的行为。

### Mode 3：Token-Efficient（Token 高效）

- 使用项目 Token-efficient 配置（`TOKEN-EFFICIENT-CONTRACT.md` 定义的策略）。
- 启用一次 planning、TaskPacket 上限、stage 聚合 review、cache key/失效、resume 增量。
- 目标：相对 Mode 1，Codex input tokens 或调用次数下降 ≥30%。

**关键约束**：三模式必须使用完全相同的任务集、质量门和验收标准（`taskFingerprint`、`qualityGateFingerprint`、`acceptanceFingerprint` 完全一致）。

## 5. 重复与统计

### 5.1 重复要求

| 模式 | 最少重复轮数 |
|------|-------------|
| Sequential Baseline | 3 |
| Default Orchestrated | 3 |
| Token-Efficient | 3 |

总计最少 9 轮。鼓励在资源允许时增加重复以提高统计功效。

### 5.2 统计口径

- **中位数**：每模式所有完成轮（含失败轮）的中位数。
- **范围**：[min, max]，包含所有完成轮。
- **异常处理**：不得丢弃失败轮。失败轮计入 failure count，其正确性指标为 FAIL，但其 usage/cost 仍应记录（标记为 partial）。
- **取消轮**：记录为 cancelled，不计入中位数但需在报告中单独列出。

### 5.3 禁止行为

- 不得丢弃任何失败轮的数据。
- 不得在失败后重跑单个轮次并替换原始数据。
- 不得将 synthetic/estimated/unavailable 数据标记为 confirmed。

## 6. 正确性门（Correctness Gates）

一轮 A/B 被认为正确性通过，必须同时满足：

| # | 条件 | 来源字段 |
|---|------|----------|
| C1 | `runStatus === "completed"` | correctness.runStatus |
| C2 | `stageStatus === "completed"`（所有 stage） | correctness.stageStatus |
| C3 | `allTasksMerged === true` | correctness.allTasksMerged |
| C4 | `targetBranchContentCorrect === true` | correctness.targetBranchContentCorrect |
| C5 | `hasConflict === false` | correctness.hasConflict |
| C6 | `hasPaused === false` | correctness.hasPaused |
| C7 | `hasWaitingDecision === false` | correctness.hasWaitingDecision |
| C8 | `hasMergeBlocked === false` | correctness.hasMergeBlocked |
| C9 | `hasLeftoverWorktree === false` | correctness.hasLeftoverWorktree |

**全部 C1-C9 为 true/passed**，该轮正确性门通过。任一失败，该轮正确性门 FAIL。

### 模式级正确性

一个模式正确性通过 = 该模式所有完成轮全部满足 C1-C9。

### A/B 级正确性

A/B 正确性通过 = 三模式全部正确性通过。

## 7. Token 效率门（Efficiency Gate）

以 Mode 1（sequential baseline）的 Codex input tokens 和 Codex 调用次数的中位数为基准：

```text
codexInputReduction = 1 - (tokenEfficient.codexInputTokens.median / sequential.codexInputTokens.median)
codexCallReduction  = 1 - (tokenEfficient.callCount.median / sequential.callCount.median)
```

效率门通过条件：

```text
codexInputReduction ≥ 0.30  OR  codexCallReduction ≥ 0.30
```

阈值值（默认 0.30，即 30%）必须在报告中明确显示。

即使阈值未达到，也必须报告实际下降比例，但不能标记为 PASS。

## 8. 失败、取消、重试与恢复

### 8.1 统计口径

| 事件 | 计入 | 不计入 |
|------|------|--------|
| 完成轮（pass 或 fail） | 中位数、范围、failure count | — |
| 取消轮（cancelled） | 单独列出 | 中位数 |
| 重试（同轮内 retry） | retryCount、recoveryTime | — |
| 外部中断恢复 | recoveryTime | — |

### 8.2 重试边界

- 同轮内 retry 上限由项目 bounded-retry 配置决定。
- 超过上限的轮标记为 failed（runStatus = "failed"），不计为 cancelled。

### 8.3 停止条件

- 用户随时可发出停止指令。
- 连续两轮正确性 FAIL，暂停该模式并记录 BLOCKED。
- 任何涉及真实凭据泄漏风险的情况，立即停止。

## 9. 数据分类标签

所有数值必须严格标注来源：

| 标签 | 含义 | 可用场景 |
|------|------|----------|
| `confirmed` | 从 Provider API response 提取的真实计量 | usage、cost |
| `estimated` | 基于 tokenizer 或统计模型估算 | usage、cost |
| `unavailable` | Provider 未返回该计量 | usage、cost |
| `synthetic` | 人工构建或模拟数据 | 仅限示例/测试 |

**禁止混合**：同一报告的 `usage` 和 `cost` 字段中，`confirmed` 与 `synthetic` 不得同时出现。若任一字段为 `synthetic`，整个报告必须标记 `dataClassification: "synthetic"`。

## 10. 授权与安全

### 10.1 用户授权点

以下节点**必须**获得用户明确授权，不得自动继续：

1. 创建 disposable 仓库（含 Git worktree 操作）。
2. 首次调用真实 Pi Provider。
3. 首次调用真实 Codex Provider。
4. 切换到下一模式。
5. 任何涉及网络访问的操作。

### 10.2 停止条件

- 用户撤销授权。
- 检测到非 disposable 环境。
- 检测到真实凭据出现在日志或输出中。
- 连续两轮正确性 FAIL。

### 10.3 隐私/凭据处理

- 不得读取 `.env` 文件。
- 不得打印或写入任何 API key、token、密码。
- 不得在 evidence path 中包含绝对用户路径。
- 所有 evidence 使用纯相对 POSIX 路径（如 `evidence/round-001/summary.json`）。
- run ID 使用随机/脱敏标识符，不含用户信息。

### 10.4 不可逆操作清单

- 真实 Provider API 调用（消耗 quota/预算）。
- Git push 到远程仓库。
- 修改 disposable 仓库外的任何文件。

## 11. 验收与交付

### 11.1 A/B 通过条件（ALL 必须满足）

1. 前置门 G1-G5 全部满足。
2. 九轮全部完成（无 cancelled）。
3. A/B 级正确性通过（C1-C9 全部满足）。
4. Token 效率门通过（≥30% 下降）。
5. 所有数据标签为 `confirmed`（非 synthetic/estimated/unavailable）。
6. `tools/validate-real-provider-ab-report.mjs --report <结果JSON>` 退出码 0。

### 11.2 A/B FAIL 条件（任一触发）

- 任一前置门未满足。
- 任一模式正确性 FAIL。
- Token 效率门未通过。
- 数据标签含 synthetic 或混合分类。
- Validator 退出码非 0。

### 11.3 交付物

完成 A/B 后交付：

1. `docs/REAL-PROVIDER-AB-RESULT.json`（符合 `REAL-PROVIDER-AB-RESULT-TEMPLATE.json` 的 schema）。
2. validator 通过的输出摘要。
3. 最终 handoff 文档。

## 12. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-07-28 | 初始协议，基于独立审查报告 FAIL 状态制定 |
