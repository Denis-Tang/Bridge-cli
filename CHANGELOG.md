# Changelog

## v0.1.0（2026-08-17）— 阶段 0 收口 + wave2 全部落地

> 版本说明：这是正式仓库 `C:\Users\29672\Documents\bridge` 自 `b36adca`（fix: block Pi clarification policy violations）之后的首次聚合发布。全部改动经「先审后合」：每批先过真实 Codex review（本地 codex-cli）再落正式仓库；全程未发起真实 Pi 调用。

### 阶段 0 修复（来源 disposable-target main，commit `8b49970`）

- Codex review 结果严格解析：`BEGIN/END_REVIEW_RESULT_JSON` 标记块、schema + 语义校验；未知顶层字段不再持久化。
- 严格 review marker JSON（fake reviewer 同步）；recover v2/v3：允许恢复被误判的 `rework_required` / 缺 task review 的 attempt。
- 真实 Codex review 修复：approved/rework_required 携带 `reviewerUnavailable=true` 或失败类 `executionMetadata` 现被拒绝（语义矛盾）；task-id 提取正则支持含点 ID；fake runner 未配置时 fail-closed。

### 02 · Pi 提交可靠性（commit `79f197a`）

- WorkerResult `commitHash` 契约收紧：schema 要求 completed 必填非空；调度器在进入 `worker_completed` 前 fail-closed 校验 `commitHash == worktree HEAD`。
- WorkerResult 丢失时自动取证接纳（`worker_auto_recovery`）：仅当 worktree HEAD 可验证、provenance 匹配、scope 不越界时采纳；绝不伪造 Pi 完成。
- int worktree 依赖准备（junction/symlink 到 run 本地依赖副本）；空 node_modules 目录不再跳过链接。

### 03 · 构建预检（commit `0b26727`）

- postbuild 自动复制 15 个 `.sql` 迁移到 dist；doctor 预检增强；README 补充运行规则。

### 06 · reconcile trusted stage review（commit `ab9901d`）

- 修复 `hasStageReviewEvidence` 跨 commit 锁定缺陷；`isLatestBatchTrustedStageReview` 要求 batch completed。
- 真实 Codex review 修复：trusted proof 兼容 `--no-ff` merge（被审树 == 最终 merge 树，hash 可不同）；不依赖被 cleanup 删除的 integration branch；pre-merged 收敛路径证据标准与 reconcile 对齐（reviewer=codex-cli）。

### 08 · product（commit `3e70a9b`）

- Locked resume pause semantics；stage review `passed` 显式排除 unavailable/failed reviewer。

### 07 · docs（commit `2f03243`）

- 2026-08-16 Phase 0 freeze 证据（4 项决策）+ costBudget 配额口径；历史快照逐字保留并降级嵌套。

### 015 迁移 + 集成幂等 wave（commit `72f508b`）

- `015_backfill_legacy_attempt_provenance.sql`：早于 012 的 attempt 从库内既有证据回填不可变 provenance。
- 集成幂等测试：pre-merged target、merge-blocked convergence、legacy provenance 回填。

### 验证

- `npm run build`：tsc + postbuild 15/15 `.sql` ✓
- `npx vitest run --pool=threads`：**95 文件 / 1190 用例全绿** ✓
- `git diff --check`：干净 ✓
- 历史套件数字（快照，勿与当前混写）：82/1016（08-02）、92/92+1082/1082（08-16 早）、95/1181（08-16 晚）、95/1190（本版）。
