# HANDOFF-ACCEPTANCE-RED-TEAM.md

## 任务 04 交付：Benchmark 与验收红队收口

**完成日期**: 2026-07-27  
**执行 Agent**: DeepSeek V4 Pro (reviewer)  
**施工目录**: `精简可运行版`

---

## 一、修改文件清单

| # | 文件 | 修改类型 | 变更说明 |
|---|------|---------|---------|
| 1 | `tests/helpers/benchmark-fixtures.ts` | Bug 修复 | ① `assertOverlap`/`assertDependsAfterAll`/`assertNoOverlap` 三个函数添加 `async` 关键字（原非 async 函数内使用 `await` 导致 esbuild 编译失败，0 测试被收集）；② `BenchPiRunner` 构造函数新增可选 `fileMap` 参数，用 DAG 定义的文件映射代替硬编码 T6→`src/a.ts`；③ `DEFAULT_FILE_MAP` 与 `CORRECT_DAG` 对齐（T6→`src/config.ts`，T7→`lib/helper.ts`，T8→`src/api.ts` 等）；④ `setupBenchmark` 从 DAG 自动构建 `fileMap` 传给 `BenchPiRunner`；⑤ `verifyTargetBranchFile` 使用 `replaceAll('\r\n','\n')` 防御 Windows CRLF 转换；⑥ `makeGitRepo` 新增 `core.autocrlf=false` 配置 |
| 2 | `tests/core/benchmark-correctness.test.ts` | 断言修正 | CORR-06 重写：用 CONFLICT_DAG 正确验证 "paused stage 不能导致 run=completed" 核心不变量，不再错误断言 paused stage 数量为 0 |
| 3 | `tests/core/benchmark-concurrency.test.ts` | Bug 修复 | ① 所有 `assertOverlap`/`assertDependsAfterAll`/`assertNoOverlap` 调用添加 `await`；② CONC-08 文件内容比对添加 CRLF 规范化 |
| 4 | `tests/acceptance/red-team-regression.test.ts` | Bug 修复 | RED-05 文件内容比对添加 CRLF 规范化 |
| 5 | `tests/core/benchmark-long-task.test.ts` | 重写 | 从 `expect(true).toBe(true)` 永真 smoke 改为验证 5 个 v3 benchmark 文件存在且路径正确的真实导向测试 |
| 6 | `docs/HANDOFF-ACCEPTANCE-RED-TEAM.md` | 新建 | 本文档 |

### 禁止修改
- **未修改任何 `src/**` 文件** ✅
- **未降低任何断言** ✅
- **未将失败改为 skip/todo** ✅

---

## 二、测试结果汇总

### 2.1 Benchmark & 红队套件（5 文件，38 测试）

| 文件 | 测试数 | 通过 | 失败 | 状态 |
|------|--------|------|------|------|
| `tests/core/benchmark-correctness.test.ts` | 6 | 6 | 0 | ✅ |
| `tests/core/benchmark-concurrency.test.ts` | 8 | 8 | 0 | ✅ |
| `tests/core/benchmark-token.test.ts` | 9 | 9 | 0 | ⚠️ TOK-08 永久红灯 |
| `tests/acceptance/red-team-regression.test.ts` | 14 | 14 | 0 | ✅ |
| `tests/core/benchmark-long-task.test.ts` | 1 | 1 | 0 | ✅ |
| **合计** | **38** | **38** | **0** | |

> 注：TOK-08 (token-efficient mode not implemented) 断言 `tokenEfficientMerged === false`，始终红灯，这是有意设计——在 P1-5 功能实现前不伪造绿色。

### 2.2 三次完整运行统计

| 轮次 | 文件通过 | 测试通过 | 耗时 |
|------|---------|---------|------|
| Run 1 | 5/5 | 38/38 | 126.52s |
| Run 2 | 5/5 | 38/38 | 125.33s |
| Run 3 | 5/5 | 38/38 | 132.64s |

| 指标 | 值 |
|------|-----|
| 中位数耗时 | 126.52s |
| 范围 | 125.33s – 132.64s |
| 变异系数 (CV) | ~3.1% |
| 稳定性 | ✅ 稳定 |

### 2.3 完整套件 (`npm test`)

```
Test Files:  60 passed | 1 failed (61)
Tests:       805 passed | 1 failed (806)
```

唯一失败: `tests/core/m3-adaptive-dispatch.test.ts > cpu >85% scales budget down` — **预存超时**（与本次修改无关，任务 03 已记录）。  
**新增回归: 0** ✅

### 2.4 构建

```
npm run build: clean ✅
```

---

## 三、发现的源码问题与返工清单

### P0 — 必须在批次 B 前解决

| ID | 问题 | 证据 | 建议返工提示词 |
|----|------|------|---------------|
| P0-BENCH-01 | integration conflict 后 stage paused，但所有 6 个 attempt 均为 approved。approved → paused 状态跃迁缺失验收检查 | RED-07 输出: `Stage 1 PAUSED: 6/6 attempts approved` | "integration conflict 导致 stage paused 时，所有 attempt 已 approved 但 merge 被阻断。在 `StageScheduler` 的 integration 阶段增加 `rolling_back_approved` 状态转换：整合冲突时将所有 approved attempt 置为 `merge_blocked`，防止 approved 但未 merged 的残留状态。" |
| P0-BENCH-02 | CORRECT_DAG 中 T6 `expected_write_missing`（已通过 fixture 修复规避，但调度器侧的 `expected_write_missing` 检测逻辑可能对其他场景误报） | 原始调度器日志: `Completion evidence rejected for attempt ... expected_write_missing` | "检查 `CompletionEvidence` 校验逻辑：当 worker 写入了文件但路径与 `estimatedWritePaths` 不完全匹配时（如文件创建在子目录），不应一律判为 `expected_write_missing`。增加基于 `git diff --name-only` 的文件存在性备用检查。" |

### P1 — 批次 B 期间处理

| ID | 问题 | 证据 | 建议返工提示词 |
|----|------|------|---------------|
| P1-BENCH-01 | Token-efficient 模式完全未实现 | TOK-08 永久红灯，TOK-09 验证无虚假节省 | "实现 P1-5 token-efficient 模式：one-time planning → minimal TaskPacket → local task gate → per-stage/risk aggregated Codex review → incremental diff → review cache → resume without repeated calls" |
| P1-BENCH-02 | sequential 与 orchestrated Pi 调用数不一致 (6 vs 7) | TOK-03: Sequential Pi=6, Orchestrated Pi=7；CORRECT_DAG 有 8 个任务但 sequential 只执行了 6 个 Pi 调用 | "检查 sequential (maxParallel=1) 模式下的任务调度：与 orchestrated 模式使用相同 DAG 但部分任务未获得 Pi 执行。排查 governance/budget 层是否在低并发时过度限制。" |

---

## 四、Codex Token 结论

| 结论 | 说明 |
|------|------|
| **BLOCKED / NOT PROVEN** | Token-efficient 模式（P1-5）尚未合并。所有 Token 数据标记为 `synthetic: true`，不得宣称真实节省。 |

**证据类型**:
- 所有 Pi/Codex 调用来自 `BenchPiRunner` / `BenchCodexRunner`（fake provider）
- 所有 `tokenUsage` 字段标记 `synthetic: true`
- 成本计算基于 `SYNTHETIC_COSTS` 常量模型
- Ledger 完整性检查通过（无重复 callId，无 estimated 残留）

**Baseline（供批次 B 任务 06 使用）**:
| 模式 | Pi 调用 | Codex 调用 | Wall 时间 | 合成 Token 总计 |
|------|---------|-----------|----------|----------------|
| Sequential (CORRECT_DAG, 8 tasks) | 6–8 | 5 | ~5.8s | ~9,800 |
| Orchestrated (CORRECT_DAG, 8 tasks, maxParallel=4) | 7–8 | 5 | ~4.0s | ~10,800 |

---

## 五、完成度评估

| 维度 | 状态 |
|------|------|
| 测试收集 | ✅ 5 文件 38 测试全部收集，0 收集失败 |
| 测试执行 | ✅ 38/38 通过（含 TOK-08 永久红灯） |
| 3 轮稳定性 | ✅ CV < 5%，无抖动失败 |
| Fake/disposable only | ✅ 所有 git repo、SQLite、worktree 在 finally 中清理 |
| 禁止修改 src | ✅ 零修改 |
| 构建通过 | ✅ `tsc` clean |
| 新增回归 | 0 |

---

## 六、批次 B 准入判定

| 准入条件 | 状态 |
|----------|------|
| 全部 benchmark 测试 0 收集失败 | ✅ |
| 全部 benchmark 测试非 0 test | ✅ |
| 无 `expect(true).toBe(true)` 冒充验收 | ✅ |
| 红队测试可靠，能捕获旧错误 | ✅ |
| 存在 P0 红灯？ | **是** — P0-BENCH-01 (approved→paused 无回退)、TOK-08 (token-efficient 永久红灯) |
| Token 结论为 BLOCKED | ✅ |

### ⚠️ 判定: 不允许直接进入批次 B

**理由**:
1. **P0-BENCH-01**: integration conflict 后 stage paused 但所有 attempt 呈 `approved` 状态，缺少 `merge_blocked` 回退。这会导致 upstream 消费者（如报告生成器）将 `approved` 误解为可合并。
2. **TOK-08**: Token-efficient 模式 BLOCKED。在 P1-5 实现前，无法对 Token 节省做任何有效 A/B 比较。
3. 虽然测试全部通过（38/38），但 TOK-08 是**结构性红灯**——不是测试写错了，而是功能缺失。

**建议**: 批次 B 启动前，先完成 P0-BENCH-01（attempt 状态回退）的源码修复，并在 token-efficient 模式下记录 baseline（即使该模式仍为 BLOCKED，baseline 本身有验收价值）。

---

## 七、附录：测试明细

### CORRECTNESS (6 tests)
| ID | 说明 | 结果 |
|----|------|------|
| CORR-01 | 8-task conflict-free DAG 多次运行 100% 完成 | ✅ |
| CORR-02 | 10-task stress DAG 全部完成 | ✅ |
| CORR-03 | CONFLICT_DAG 100% 正确阻止完成 | ✅ |
| CORR-04 | T1+T6 同文件 → 集成冲突检测 | ✅ |
| CORR-05 | 无 approved-but-not-merged 残留 | ✅ |
| CORR-06 | paused stage 阻止 run=completed | ✅ |

### CONCURRENCY (8 tests)
| ID | 说明 | 结果 |
|----|------|------|
| CONC-01 | T1-T4 独立任务并发重叠 | ✅ |
| CONC-02 | T5 依赖必须在 T1,T2 结束后启动 | ✅ |
| CONC-03 | T7/T8 多跳依赖链验证 | ✅ |
| CONC-04 | T1,T6 同路径不重叠（序列化） | ✅ |
| CONC-05 | 串行 wall time > 理论最小 | ✅ |
| CONC-06 | 编排模式显著快于串行 | ✅ |
| CONC-07 | 3 轮稳定性 CV < 13% | ✅ |
| CONC-08 | 目标分支包含全部任务内容 | ✅ |

### TOKEN (9 tests)
| ID | 说明 | 结果 |
|----|------|------|
| TOK-01 | 全部 synthetic 标记 | ✅ |
| TOK-02 | 串行基线 Token 计量 | ✅ |
| TOK-03 | 编排 vs 串行 Token 对比 | ✅ |
| TOK-04 | 无重复 callId | ✅ |
| TOK-05 | 无 estimated 残留 | ✅ |
| TOK-06 | resume 无额外 ledger 条目 | ✅ |
| TOK-07 | confirmed 条目 actualTotal > 0 | ✅ |
| TOK-08 | token-efficient 模式 BLOCKED | 🔴 永久红灯 |
| TOK-09 | 无虚假 Token 节省 | ✅ |

### RED-TEAM (14 tests)
| ID | 说明 | 结果 |
|----|------|------|
| RED-01 | T1,T6 同文件冲突 → 不能 both merged | ✅ |
| RED-02 | 集成冲突必须 produce paused/failed | ✅ |
| RED-03 | 未解决冲突不能 run=completed | ✅ |
| RED-04 | 期望文件必须存在于目标分支 | ✅ |
| RED-05 | 文件内容必须正确 | ✅ |
| RED-06 | 缺失文件必须触发失败 | ✅ |
| RED-07 | paused stage 即使全部 approved 也必须失败 | ✅ (CRITICAL BUG 已记录) |
| RED-08 | waiting_decision 不能完成 | ✅ |
| RED-09 | 重复 callId → 失败 | ✅ |
| RED-10 | estimated 条目不持久化 | ✅ |
| RED-11 | ledger 条目 ≤ 执行尝试数 | ✅ |
| RED-12 | 依赖使用 max 而非 min | ✅ |
| RED-13 | 冲突任务不并发 | ✅ |
| RED-14 | 不允许弱断言制造假绿 | ✅ |
