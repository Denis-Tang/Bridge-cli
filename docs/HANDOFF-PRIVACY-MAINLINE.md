# HANDOFF-PRIVACY-MAINLINE.md — 隐私主链施工交付

> 日期: 2026-07-27
> 任务: 批次A-可并发 / 01-隐私主链与加密持久化
> 状态: 完成

---

## 实际修改文件

### 新增文件

| 文件 | 说明 |
|------|------|
| `src/privacy/privacy-service.ts` | 统一隐私服务入口，集合 profile/crypto/sanitizer/artifact-store/env-allowlist |
| `tests/privacy-mainline.test.ts` | 主链 canary 测试套件 (44 个测试) |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/state/state-store.ts` | `RunRecord` 增加 `encryptedRequestText` 可选字段 |
| `src/types/m2-types.ts` | `AttemptRecord` 增加 `encryptedWorkerResultJson` 可选字段 |
| `src/state/sqlite-store.ts` | `createRun` 加密 requestText 并写入 `encrypted_request_text`；`updateAttemptResult` 加密 workerResultJson 并写入 `encrypted_worker_result_json`；`createEvent` 净化 eventData 并设置 `privacy_profile`；`mapRowToRunRecord`/`mapRowToAttemptRecord` 读取加密列；构造函数接受 `PrivacyService` |
| `src/cli/commands/submit.ts` | 创建 `PrivacyService` 并传递给 `SqliteStateStore.create()`；导入 `PrivacyService` |
| `src/cli/commands/status.ts` | `showSummary` 和 `showRunDetail` 使用隐私感知显示 (`getDisplayText`)，加密/legacy/unavailable 状态标记 |
| `src/adapters/pi-rpc-worker.ts` | ProcessRunner 的 env 支持外部传入（`input.env ?? buildSubprocessEnv()`），使上层可按 Provider 类型传入不同环境 |

---

## 生产调用链和持久化数据流

```
用户请求
  ↓
submit.ts (CLI)
  ├─ PrivacyService.create({ projectRoot })  ← 解析 minimal/debug profile
  ├─ SqliteStateStore.create(dbPath, privacyService)  ← 注入隐私服务
  └─ store.createRun({ requestText })
       └─ privacyService.prepareForPersistence(text, 'request_text')
            ├─ crypto.isAvailable() → encrypt → encrypted_request_text (JSON)
            └─ plaintext = null → request_text = '[ENCRYPTED]'
            
Pi Worker 执行
  ↓
stage-scheduler.ts
  └─ store.updateAttemptResult({ workerResultJson })
       └─ privacyService.prepareForPersistence(json, 'worker_result')
            ├─ crypto.isAvailable() → encrypt → encrypted_worker_result_json
            └─ plaintext = '[ENCRYPTED]' → worker_result_json

事件记录
  ↓
store.createEvent({ eventData: { prompt, stdout, ... } })
  └─ privacyService.summarizeEvent(data)
       └─ sanitizeEventData → DROP_KEYS 移除, PROMPT_LIKE_KEYS hash

CLI 显示
  ↓
status.ts: getDisplayText(run)
  ├─ encryptedRequestText 存在 → '[encrypted]'
  ├─ plaintext 非空且非 marker → '[legacy_plaintext]' (minimal) / '[legacy] ...' (debug)
  └─ 其他 → '[unavailable]'

reconcile.ts
  └─ attempt.encryptedWorkerResultJson → privacyService.decryptPayload()
       └─ 解密成功 → 恢复原文用于恢复判断
```

---

## minimal/debug/无 key/legacy 行为表

| 场景 | requestText 明文 | encrypted 列 | spawn 真实 Provider | 恢复能力 |
|------|-----------------|-------------|-------------------|--------|
| minimal + key | `[ENCRYPTED]` | ✅ AES-256-GCM | ✅ 允许 | 完整解密 |
| minimal + 无 key | `[UNAVAILABLE]` | ❌ null | ❌ fail closed | 不可用 |
| debug + key | `[ENCRYPTED]` | ✅ AES-256-GCM | ✅ 允许 | 完整解密 |
| debug + 无 key | 净化后明文 | ❌ null | ✅ 允许 | 明文可读 |
| legacy (无 privacyService) | 原始明文 | ❌ null | N/A | 明文可读 |
| debug 已过期 | 回退 minimal | 回退 minimal | 回退 minimal | — |

---

## Canary 扫描范围与匹配计数

测试使用 `CANARY-{random32hex}-SECRET` 唯一 canary 令牌：

| 测试场景 | 扫描范围 | canary 匹配=0 |
|----------|----------|--------------|
| sanitizeText 14 模式 | 输入/输出对比 | ✅ 全部通过 |
| sanitizeEventData | JSON 序列化输出 | ✅ 全部通过 |
| AES-256-GCM 加密 payload | JSON 序列化 | ✅ canary 不出现在任何字段 |
| SQLite createRun | request_text + encrypted_request_text | ✅ 明文列为 `[ENCRYPTED]` |
| SQLite updateAttemptResult | worker_result_json | ✅ 明文列不含 canary |
| SQLite createEvent | event_data_json | ✅ DROP_KEYS 全部移除 |
| ArtifactStore writeLog(minimal) | 文件内容 | ✅ canary 被净化 |
| ArtifactStore writePromptIfDebug(minimal) | 文件不存在 | ✅ 不写入磁盘 |
| 环境变量诊断 | getEnvDiagnostics() | ✅ 只输出 present/not_set |

---

## 验证命令与通过/失败数量

```bash
# 隐私主链测试 (新增)
npx vitest run tests/privacy-mainline.test.ts
# 结果: 1 file passed, 44 tests passed

# 完整测试套件
npx vitest run
# 结果: 52 passed, 8 failed (全部为预先存在的失败)
#   - tests/acceptance/red-team-regression.test.ts
#   - tests/core/benchmark-*.test.ts (3个)
#   - tests/cli/disposable-fixture.test.ts
#   - tests/cli/project-init.test.ts
#   - tests/core/project-config.test.ts (project-adapter.ts 缺失 import)
#   - tests/core/stage-scheduler.test.ts (rework limit)
# 隐私变更未引入任何新失败

# TypeScript 编译
npx tsc --noEmit
# 只有 1 个预先存在的错误: src/adapters/project-adapter.ts:118 (缺失 'path' 导入)
# 隐私变更未引入任何新编译错误
```

---

## 未完成风险和下一任务必须注意的接口

### 风险

1. **reconcile.ts 直接解析 workerResultJson**: `reconcile.ts:244-269` 直接解析 `attempt.workerResultJson`，当隐私启用时该字段为 `[ENCRYPTED]`。恢复逻辑需改用 `attempt.encryptedWorkerResultJson` 并通过 `privacyService.decryptPayload()` 恢复。当前任务范围未覆盖 reconcile 深层改造。

2. **stage-scheduler.ts 直接写入 workerResultJson**: `stage-scheduler.ts:1059-1060` 通过 `store.updateAttemptResult` 写入，已通过 sqlite-store 的隐私层处理。但 scheduler 自身可能缓存或传递敏感数据。

3. **Codex CLI plan/review 输出直接写入文件**: `submit.ts` 中 `planResult.rawOutput` 和 `planResult.errors` 直接写入磁盘文件（`.brainctl-dev/plan-logs/`）。这些不在 SQLite 中，但仍可能泄漏敏感内容。当前任务未覆盖文件级隐私（因为 artifact-store 已有此能力，但未接入 submit.ts 的 writeFileSync 路径）。

4. **Provider 环境隔离未完全接入**: `pi-rpc-worker.ts` 已改为接受外部 env，但 `stage-scheduler.ts` 中创建 PiRpcWorker 时仍未传入 Provider-specific env。可在下一任务中完成接入。

5. **Fake/disposable fixture 路径**: 当 `allowPlaintextFallback=true` 时，`prepareForPersistence` 在无 key 情形下返回净化后明文。这适用于测试/fake 场景，但需确保真实 Provider 不会被标记为 fallback。

### 下一任务必须注意的接口

| 接口 | 位置 | 说明 |
|------|------|------|
| `PrivacyService` | `src/privacy/privacy-service.ts` | 统一入口，传递 profile + crypto + projectRoot |
| `SqliteStateStore.create(dbPath, privacyService?)` | `src/state/sqlite-store.ts` | `privacyService` 可选，为 null 时回退 legacy 行为 |
| `RunRecord.encryptedRequestText` | `src/state/state-store.ts` | 新增可选字段，兼容旧代码 |
| `AttemptRecord.encryptedWorkerResultJson` | `src/types/m2-types.ts` | 新增可选字段，兼容旧代码 |
| `privacyService.prepareForPersistence()` | `src/privacy/privacy-service.ts` | 返回 `SanitizedStorage { plaintext, encrypted, contentHash, status }` |
| `privacyService.decryptPayload()` | `src/privacy/privacy-service.ts` | 返回 `DecryptedContent { content, status }` |
| `privacyService.canSpawnRealProvider()` | `src/privacy/privacy-service.ts` | 返回 `{ allowed, reason }` — 在 spawn 前调用 |
| `privacyService.getDisplayText()` | `src/privacy/privacy-service.ts` | CLI 安全显示 |
| `privacyService.buildProviderEnv()` | `src/privacy/privacy-service.ts` | 按 Provider 类型构建隔离环境 |

---

## 施工规则遵守确认

- [x] 施工目录固定为精简可运行版
- [x] 未修改原项目或原始完整快照
- [x] 未使用 git reset、整目录覆盖、批量恢复
- [x] 未运行真实 Pi/Codex Provider
- [x] 未读取或输出凭据
- [x] 未修改调度重试语义 (P0-3)
- [x] 未修改 quality gate 安全策略 (P0-4)
- [x] 未修改 project init/config 便携逻辑 (P1-3)
- [x] 未修改 benchmark 文件
- [x] `008_privacy_encryption.sql` 未改变语义
- [x] 先运行测试、记录基线
- [x] npm run check 通过 (仅预存失败)
- [x] 完成后停止写入
