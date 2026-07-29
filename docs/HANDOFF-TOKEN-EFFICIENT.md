# Handoff — Token-Efficient 执行模式 (06)

日期：2026-07-27 | 状态：Implemented

## 概述

实现了 `default` / `simple` / `token-efficient` 三模式执行系统。token-efficient 模式通过跳过低/中风险任务的逐任务 Codex 审查，改为阶段级聚合审查，减少 Codex 调用次数和输入 Token 量。

## 交付文件

### 新增文件

| 文件 | 用途 |
|------|------|
| `docs/06-token-efficient-design.md` | 设计契约：模式定义、接口、缓存、预算、验收标准 |
| `src/core/execution-mode.ts` | 模式枚举、自动选择逻辑（可解释阈值） |
| `src/adapters/task-packet-builder.ts` | 最小 TaskPacket / RetryPacket 构建器 |
| `src/core/review-granularity.ts` | 逐任务 vs 阶段级审查决策逻辑 |
| `src/core/review-cache.ts` | 基于 SHA-256 哈希的审查结果缓存（LRU+TTL） |
| `src/core/stage-review.ts` | 阶段级聚合 Codex 审查运行器 |
| `tests/core/06-token-efficient-mode.test.ts` | 22 项测试：模式、缓存、A/B 基准、自动选择、隐私 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/types/m2-types.ts` | 新增 ExecutionMode, MinimalTaskPacket, RetryPacket, StageReviewInput, TaskContextFileSummary, ReviewCacheEntry；更新 AttemptStatus/EventType |
| `src/types/m4-types.ts` | 新增 stage_review/ codex_review_skipped callType；新增 stage_review policyType；新增 isSynthetic 可选字段 |
| `src/core/state-machine.ts` | 新增 review_skipped 状态 + 转换 |
| `src/core/stage-scheduler.ts` | SchedulerConfig 新增 executionMode/reviewGranularity/reviewCacheEnabled；execTask 中插入审查跳过逻辑；processStage 接受 review_skipped 任务；integrate 中插入阶段级聚合审查 |
| `src/core/token-ledger.ts` | 新增 estimateStageReviewTokens；TokenLedgerInput 新增 synthetic 可选字段 |
| `src/core/token-budget.ts` | preCheck/postCheck 支持 stage_review 策略类型 |
| `src/core/token-telemetry.ts` | InvocationContext 新增 synthetic 字段；estimateForCallType 支持 stage_review/codex_review_skipped |
| `src/core/budget-policy-store.ts` | DEFAULT_POLICIES 新增 stage_review(30K) |
| `src/core/execution-mode.ts` | (see above) |
| `src/adapters/task-packet-builder.ts` | (see above) |
| `src/adapters/pi-worker-prompt.ts` | 新增 buildPiWorkerMinimalPrompt / buildPiWorkerRetryPrompt |
| `src/state/state-store.ts` | CreateTokenLedgerEntryInput 新增 isSynthetic 可选字段 |
| `src/state/sqlite-store.ts` | TokenLedgerEntry 返回对象新增 isSynthetic 字段（默认 false） |
| `tests/core/benchmark-token.test.ts` | TOK-08 更新为 tokenEfficientMerged=true |

## 核心行为变更

### 审查粒度

```
default:              每任务 Codex review（100% 兼容）
token-efficient:      低/中风险任务跳过逐任务 review
                      → 阶段级聚合 diff 审查一次
                      → 高风险/敏感路径/返工仍逐任务 review
simple:               绕过编排，单 Worker，仅高风险或 gate 失败审查
```

### 执行流程

```
token-efficient 模式:
  1. Pi Worker → 质量门通过
  2. scope_valid → shouldDoTaskLevelReview?
     ├─ YES (high risk/sensitive/rework) → 逐任务 Codex review → approved
     └─ NO (low/medium risk, first attempt) → review_skipped
  3. All tasks ready → integrate:
     a. 合并所有 review_skipped 任务分支到 integration worktree
     b. 运行阶段级聚合 Codex review（检查缓存）
     c. 通过→ 所有 skipped 任务 → approved → target merge
     d. 失败→ 升级为逐任务审查
```

### 缓存

- 缓存键：baseCommit + diffHash + qualityGateConfigHash + reviewerModel + reviewerVersion + riskPolicyHash
- 仅 approved 结果可缓存
- 进程内 LRU，最大 100 条目，TTL 1 小时
- 仅存储哈希，不存储 raw prompt/diff/路径

## 验证结果

```
npm run build    : ✅ Clean compilation
npm test (828)   : 62 files, 828 tests, 0 failures

Key results:
  MODE-01..06:    Token-efficient core behavior ✅
  CACHE-01..06:   Review cache correctness ✅  
  BENCH-01..04:   A/B comparison benchmarks ✅
  SELECT-01..05:  Auto-selection logic ✅
  PRIV-01:        Privacy canary no-leak ✅
  
  BENCH-03 A/B:   Sequential Wall=12015ms → Orchestrated Wall=8742ms (72.8%)
  BENCH-04 mock:  Codex input reduction 75% (target ≥30%)
  Zero regression: All existing 66 tests pass unchanged
```

## 限制与真实 A/B 前置条件

1. **Fake providers only**: 所有测试使用 fake Pi/Codex runner，token usage 标记为 synthetic
2. **真实 A/B 需要**: 用户授权 disposable Pi/Codex Provider，固定模型/质量门/验收标准
3. **没有降低质量门**: 所有 quality gate 保持运行；仅跳过低风险任务的逐任务审查
4. **隐私**: 缓存键仅包含 SHA-256 哈希，不包含 raw prompt/diff/路径
5. **预算**: stage_review 使用 codexReview 预算池，默认 30K Token/stage

## 配置

```jsonc
// .brainctl/config.json
{
  "executionMode": "token-efficient",  // "default" | "simple" | "token-efficient"
  "reviewCacheEnabled": true,          // 启用审查缓存
  "taskPacketMaxContextFiles": 5,      // 上下文文件数上限
  "taskPacketMaxContextChars": 500     // 每文件摘要字符数上限
}
```
