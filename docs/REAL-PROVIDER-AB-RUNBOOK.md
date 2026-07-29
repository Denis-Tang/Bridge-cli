# Real Provider A/B Runbook

版本 1.0.0 | 状态：用户操作手册（不授权任何真实 Provider 调用）

## 0. 重要声明

**本 runbook 本身不授权任何真实 Provider 调用。** 所有真实 A/B 测试必须在满足全部前置门（见 `REAL-PROVIDER-AB-PROTOCOL.md` 第 2 节）、且用户明确给出授权文本后，方可在一次性 disposable 仓库中执行。

在授权前，本 runbook 仅作为**参考文档**，不得执行其中任何涉及真实 Provider 的步骤。

## 1. 用户授权文本

在开始任何真实 A/B 操作前，用户必须明确给出以下授权（或等价表述）：

> "我授权在一次性 disposable 仓库中执行真实 Pi/Codex Provider A/B 测试。我了解这将消耗 API quota 并产生费用。我已确认 disposable 仓库不含真实项目凭据或敏感数据。"

**缺少上述授权，不得继续。**

## 2. Disposable 仓库准备

### 2.1 创建一次性仓库

```powershell
# 从精简可运行版创建 disposable 副本（不在原项目内操作）
git clone "D:\仓库集合\仓库1\codex-brain-pi-orchestrator-backup2\精简可运行版" "D:\临时\ab-disposable-YYYYMMDD-HHmmss"
```

**注意事项：**
- 副本路径必须在项目目录之外（如 `D:\临时\`）。
- 副本不得包含 `.env` 文件。若有，立即删除。
- 确认副本不含 API key、token、密码等凭据：
  ```powershell
  rg -l "(sk-|api_key|token|secret|password)" --ignore-case "D:\临时\ab-disposable-*" -g "!.git" 2>&1
  ```
  若有命中，必须清理后再继续。

### 2.2 固定版本

```powershell
cd "D:\临时\ab-disposable-YYYYMMDD-HHmmss"

# 记录固定版本信息
node --version > ab-version-info.txt
npm --version >> ab-version-info.txt

# 从 package.json 提取版本
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).version)" >> ab-version-info.txt
```

这些版本信息将填入结果报告的 `modelInfo.providerVersion`。

### 2.3 创建目标分支

```powershell
git checkout -b ab-target
```

### 2.4 确认环境类型

确保所有命令在 disposable 环境中运行，环境变量或配置中不含生产/开发标识。

## 3. 执行顺序

严格按以下顺序执行，不得跳过或重排：

```
Mode 1 (Sequential Baseline) × 3 → Mode 2 (Default Orchestrated) × 3 → Mode 3 (Token-Efficient) × 3
```

每完成一轮，立即记录结果到 JSON 报告。在完成所有 9 轮前，不得修改任何参数。

## 4. 单轮执行与结果收集

### 4.1 开始前

```powershell
# 重置目标分支到基础 commit
git checkout ab-target
git reset --hard <基础commit>

# 清理残留工作树
git worktree list
git worktree prune
```

### 4.2 运行测试

根据当前模式选择命令：

| 模式 | 命令（示例） |
|------|-------------|
| Sequential Baseline | 原始 Codex/Pi 调用入口，无编排 |
| Default Orchestrated | 项目默认入口（含编排/scheduler/retry） |
| Token-Efficient | Token-efficient 配置入口 |

> **注意**：具体命令取决于项目实际 CLI 入口。必须在授权后、执行前确定并固定，不得在各轮间更改。

### 4.3 收集结果

每轮完成后，记录以下数据到 JSON 报告：

#### 必须记录

| 分类 | 字段 | 来源 |
|------|------|------|
| 标识 | runId | 生成随机/脱敏 ID |
| 标识 | mode | `sequential-baseline` / `default-orchestrated` / `token-efficient` |
| 标识 | repeatNumber | 1, 2, 或 3 |
| 标识 | timestamp | ISO 8601 开始时间 |
| 正确性 | runStatus | 观察最终状态 |
| 正确性 | stageStatus | 所有 stage 状态 |
| 正确性 | allTasksMerged | 检查所有任务是否 merged |
| 正确性 | targetBranchContentCorrect | 比对目标分支内容 |
| 正确性 | hasConflict | 是否有冲突 |
| 正确性 | hasPaused | 是否有 paused 任务 |
| 正确性 | hasWaitingDecision | 是否有 waiting_decision |
| 正确性 | hasMergeBlocked | 是否有 merge_blocked |
| 正确性 | hasLeftoverWorktree | 检查 `git worktree list` |
| 用量 | codex.inputTokens | Codex API response |
| 用量 | codex.outputTokens | Codex API response |
| 用量 | codex.cacheTokens | Codex API response |
| 用量 | codex.callCount | 统计 Codex 调用次数 |
| 用量 | pi.inputTokens | Pi API response |
| 用量 | pi.outputTokens | Pi API response |
| 用量 | pi.cacheTokens | Pi API response |
| 用量 | totalTokens | 所有 provider 总和 |
| 成本 | weightedCost | 按定价权重计算 |
| 时间 | wallTimeMs | `Date.now()` 差值 |
| 时间 | retryCount | bounded-retry 触发次数 |
| 时间 | failureCount | 任务/阶段失败次数 |
| 时间 | recoveryTimeMs | 恢复耗时 |
| 证据 | evidencePaths | 相对路径列表 |

#### 状态标签

每个 usage/cost 字段必须标注来源：

- `confirmed`：从 API response 提取的真实数据
- `estimated`：无 API 数据，基于 tokenizer 估算
- `unavailable`：Provider 未返回该字段
- `synthetic`：人工构造数据（仅限测试，真实 A/B 禁止使用）

**真实 A/B 必须全部为 `confirmed`。** 若任何字段非 confirmed，该轮标记为数据不完整，最终 A/B 判定为 FAIL。

### 4.4 证据文件

将以下内容保存到 `evidence/round-<mode>-<repeat>/`：

- `summary.json`：运行摘要
- `run.log`：运行日志（脱敏后）
- 其他相关输出

**证据路径规则：**
- 仅使用相对 POSIX 路径：`evidence/round-sequential-baseline-1/summary.json`
- 不得包含绝对路径（如 `D:\...`）
- 不得包含 `..`
- 不得包含反斜杠
- 不得包含用户名或项目真实路径

## 5. 停止条件

遇到以下情况，立即停止当前模式：

| 条件 | 处理 |
|------|------|
| 用户发出停止指令 | 停止并记录 cancelled |
| 连续两轮正确性 FAIL | 停止当前模式，记录 BLOCKED |
| 检测到凭据泄漏 | 立即停止全部，清理日志 |
| 检测到非 disposable 环境 | 立即停止，不记录任何结果 |

## 6. 使用 Validator

### 6.1 语法检查

```powershell
node --check tools/validate-real-provider-ab-report.mjs
```

### 6.2 验证结果报告

```powershell
node tools/validate-real-provider-ab-report.mjs --report ab-results.json
```

退出码：
- `0`：PASS — A/B 全部通过
- `1`：FAIL — 存在失败项
- `2`：用法错误

### 6.3 理解输出

**成功输出示例：**
```
=== Correctness Gate: PASS ===

=== Efficiency Gate ===
  Codex input reduction: 42.3% (threshold: 30.0%) ✓ met
  Codex call reduction:   28.1% (threshold: 30.0%)
  Efficiency gate: PASS ✓

=== A/B Summary ===
  (每模式中位数/范围)

=== Overall: PASS ===
```

**失败输出示例：**
```
sequential-baseline repeat #2: /correctness/runStatus — correctness_fail
default-orchestrated repeat #1: /usage/codex/inputTokens — missing_or_invalid
token-efficient repeat #3: /efficiency-gate — efficiency_gate_fail
```

输出仅包含 mode、repeat number、JSON 字段路径、失败类别。不包含敏感值。

## 7. 判定标准

### 7.1 可申请"真实 A/B 已通过"

必须**同时**满足：

1. 前置门 G1-G5 全部满足。
2. 全部 9 轮完成（无 cancelled）。
3. 每轮 C1-C9 正确性全部通过。
4. Codex input 或调用数下降 ≥30%。
5. 所有数据标签为 `confirmed`。
6. Validator 退出码为 0。

### 7.2 必须判定 FAIL/停止

以下任一触发：

- 前置门未满足。
- 任一模式正确性 FAIL。
- 效率门未通过（下降 <30%）。
- 数据标签含 synthetic 或混合分类。
- Validator 退出码非 0。
- 连续两轮正确性 FAIL。
- 凭据泄漏风险。

## 8. 完成后清理

```powershell
# 离开 disposable 目录
cd "D:\仓库集合\仓库1\codex-brain-pi-orchestrator-backup2\精简可运行版"

# 删除 disposable 副本（可选，建议保留至验收完成）
# Remove-Item -Recurse -Force "D:\临时\ab-disposable-*"
```

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-07-28 | 初始 runbook，对应 PROTOCOL v1.0.0 |
