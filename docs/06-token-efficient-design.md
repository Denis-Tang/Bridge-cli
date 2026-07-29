# Token-Efficient Execution Mode — Design Contract

版本：0.1.0 | 日期：2026-07-27 | 状态：Draft

## 1. 概述

本文档定义 Token-efficient 执行模式的类型、接口和行为契约。实现必须通过本文档中的测试准则，且不得在 default 模式下改变现有行为。

## 2. 模式定义

### 2.1 ExecutionMode

```typescript
type ExecutionMode = 'default' | 'simple' | 'token-efficient';
```

| 模式 | 描述 | 规划 | Pi 施工 | Codex 审查 | 治理 |
|------|------|------|---------|------------|------|
| `default` | 现有逐任务审查 | 需要 | 每任务一次 | 每任务一次 | 全开 |
| `simple` | 绕过编排，单 Worker | 跳过 | 一次 | 仅高风险或质量门失败 | 简化 |
| `token-efficient` | 一次规划，阶段聚合审查 | 最多一次 | 每任务一次 | 低/中风险=阶段级，高风险=任务级 | 保留G1/G2/G3 |

### 2.2 自动选择阈值

```typescript
function selectExecutionMode(plan: StructuredPlan): {
  mode: ExecutionMode;
  autoSelected: boolean;
  reason: string;
}
```

| 条件 | 自动选择 | 原因 |
|------|---------|------|
| task count ≤ 3, max risk ≤ 'medium', writePaths ≤ 5, no sensitive paths | `simple` | "小任务绕过编排，避免额外开销" |
| task count > 3 OR stage count ≥ 1 OR any high risk | `token-efficient` | "多任务编排，减少逐任务审查" |
| 明确配置 | 使用配置值 | "用户显式指定" |
| 不确定 | `default` | "保守回退到全审查模式" |

可解释性：选择原因记录为 event（`mode_selection`），包含决策树节点。

## 3. 最小 TaskPacket

### 3.1 接口

```typescript
interface MinimalTaskPacket {
  taskId: string;
  title: string;
  goal: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  contextFilesSummary: TaskContextFileSummary[];
  dependencyHash: string;
  dependencySummary: string;
  acceptanceCommands: string[];
  outputFormat: 'worker_result_json';
  riskLevel: 'low' | 'medium' | 'high';
  heavyCommandSlotsRequired: number;
  timeoutSeconds: number;
}

interface TaskContextFileSummary {
  path: string;
  hash: string;           // SHA-256 of file content
  summary: string;        // 前500字符，超长截断
  size: number;           // 文件大小（字节）
}
```

### 3.2 排除字段

不发送给 Pi Worker 的内容：
- 完整上下文文件内容（仅发送摘要和hash）
- 项目历史
- 所有 handoff 文档
- 完整先前对话
- 其他任务的 WorkerResult

### 3.3 上下文溢出策略

- 最大上下文文件数：5（可配置）
- 每文件摘要最大字符数：500（可配置）
- 超出时：记录 truncation event，继续使用截断摘要
- 不允许无限制扩充
- Pi Worker 可通过 hash 请求完整文件（如 Pi 支持）

### 3.4 重试包

```typescript
interface RetryPacket {
  originalTaskId: string;
  previousAttemptNumber: number;
  failureSummary: string;
  findings: string[];
  diffDelta: string;       // 仅上次 attempt 的增量 diff
  repairGoal: string;
}
```

不包括：完整初始需求、完整仓库摘要、历史日志。

## 4. 审查粒度

### 4.1 逐任务审查决策

```typescript
function shouldDoTaskLevelReview(
  spec: StructuredTaskSpec,
  workerResult: WorkerResult,
  qualityGatePassed: boolean,
  mode: ExecutionMode,
  isRetry: boolean,
): boolean
```

| 触发条件 | 逐任务审查 |
|----------|-----------|
| mode='default' | 是 |
| riskLevel='high' | 是 |
| 配置/密钥/敏感路径 | 是 |
| scope expansion | 是 |
| 质量门失败 | 是 |
| rework/retry（attempt > 1）| 是 |
| mode='token-efficient' + low/medium risk + first attempt + gate passed | 否（跳过） |
| mode='simple' + low risk + gate passed | 否（跳过） |

### 4.2 阶段聚合审查

```typescript
interface StageReviewInput {
  stageId: string;
  stageNumber: number;
  aggregatedDiff: string;
  taskIds: string[];
  qualityGateResults: QualityGateSummary[];
}
```

阶段审查流程：
1. 所有任务完成（worker_completed + 质量门通过 + scope/gate 通过）
2. 在隔离 integration worktree 中计算聚合 diff
3. Codex 审查聚合 diff（三层结构）：
   - diffstat + 文件清单 + 质量门摘要
   - API/配置/安全相关文件完整 diff
   - 普通文件仅在异常或 Codex 请求时发送
4. 审查通过 → target merge
5. 审查失败 → 升级为逐任务 Codex review，限制一次升级循环

### 4.3 审查状态

新增 `review_skipped` 状态：
- attempt: `validating → review_skipped`（质量门通过但 Codex 被跳过）
- task: `validating → review_skipped`（同上）

状态迁移：
- `review_skipped → approved`（阶段审查通过）
- `review_skipped → rework_required`（阶段审查失败，升级）

## 5. 审查缓存

### 5.1 缓存键

```typescript
interface ReviewCacheKey {
  baseCommit: string;
  diffHash: string;            // SHA-256 of aggregated diff
  qualityGateConfigHash: string; // SHA-256 of quality gate config
  reviewerModel: string;
  reviewerVersion: string;
  riskPolicyHash: string;      // SHA-256 of risk policy config
}

function computeCacheKey(key: ReviewCacheKey): string {
  // SHA-256 of sorted concatenation of all fields
}
```

### 5.2 缓存规则

- 仅 `approved` 结果可缓存
- 完全匹配才命中
- 进程内 LRU，最大 100 条目
- TTL 1小时（可配置）
- 仅存储 hash/元数据，不存储 raw prompt/diff

### 5.3 失效条件

- base commit 变化
- diff hash 变化
- 质量门配置变化
- reviewer 模型或版本变化
- 风险策略变化
- TTL 到期
- 结果不是 'approved'

## 6. Token Ledger 增强

### 6.1 合成标记

```typescript
// TokenLedgerEntry 新增字段
isSynthetic: boolean;  // true = fake provider 产生的 token，非真实模型
```

### 6.2 新增调用类型

- `callType: 'stage_review'` — 阶段聚合审查
- `policyType: 'stage_review'` — 对应预算策略

### 6.3 审查跳过的 Ledger 条目

当逐任务 Codex review 被跳过时：
- callType: 'codex_review_skipped'
- status: 'confirmed'
- actualTotal: 0
- isSynthetic: false
- 不生成 estimated 条目

## 7. 预算

### 7.1 调用预算（token-efficient 模式）

| 调用 | 默认上限 | 输入 |
|------|---------|------|
| 初始规划 | 每 run 1 次 | 需求 + manifest + 架构摘要 |
| 计划修复 | 每 run 最多 1 次 | schema 错误 + 原计划 hash + 最小差异 |
| 阶段审查 | 每 stage 1 次 | integration diff 摘要 + 风险文件 diff + gate 结果 |
| 逐任务审查 | 仅高风险触发 | 任务级 diff + 风险详情 |

### 7.2 预算超限行为

- 新调用前暂停
- 不杀死运行中的 Pi
- 不丢弃已完成且可恢复的结果
- 不重复调用已暂停前的调用

## 8. 隐私保证

- TaskPacket 不包含完整上下文文件内容（仅摘要和 hash）
- 缓存键仅包含 hash
- Ledger 不保存 raw prompt
- Resume 不重新发送完整历史
- Privacy canary 测试：在上下文文件中插入 canary 字符串，验证它不出现在 TaskPacket/cache/ledger 中

## 9. 集成点

### 9.1 SchedulerConfig 新增字段

```typescript
interface SchedulerConfig {
  // 新增
  executionMode?: ExecutionMode;
  reviewGranularity?: 'per-task' | 'stage-level';  // 自动推导
  reviewCacheEnabled?: boolean;
  taskPacketMaxContextFiles?: number;               // 默认 5
  taskPacketMaxContextChars?: number;               // 默认 500
}
```

### 9.2 execTask 修改

在 quality gate 通过后、Codex review 前插入：

```
if (mode === 'token-efficient' && !shouldDoTaskLevelReview(...)) {
  → 标记 attempt status = review_skipped
  → 标记 task status = review_skipped
  → 记录事件 review_skipped_token_efficient
  → return（不执行 Codex review）
}
```

### 9.3 integrate 修改

在 target merge 前插入阶段审查：

```
if (mode === 'token-efficient' && tasks have review_skipped) {
  → runStageLevelReview(stage, aggregatedDiff)
  → on pass: approve review_skipped tasks, proceed to merge
  → on fail: upgrade → per-task Codex review on skipped tasks
}
```

## 10. 验收标准

### 10.1 功能

- [ ] default 模式零回归
- [ ] token-efficient 低风险 task 无逐任务 Codex review
- [ ] 高风险 task 仍触发逐任务 Codex review
- [ ] 阶段审查在 integrate 之前运行
- [ ] 阶段审查失败触发升级
- [ ] 审查缓存命中跳过 Codex
- [ ] 缓存键变化引起缓存失效
- [ ] Resume 不重复调用
- [ ] 隐私 canary 不泄露
- [ ] simple 模式绕过编排

### 10.2 基准

- [ ] Codex input Token 中位数下降 ≥ 30%（fake A/B）
- [ ] Codex review 调用数显著减少（1 stage review vs N per-task reviews）
- [ ] 正确性不变（目标分支最终状态相同）
- [ ] 如未达到：报告 FAIL，不调整基线

### 10.3 边界

- [ ] 不运行真实 Provider
- [ ] 不访问网络
- [ ] 不移除关键审查
- [ ] 不降低质量门
- [ ] 不伪造 Token 节省
