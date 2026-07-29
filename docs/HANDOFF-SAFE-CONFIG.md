# HANDOFF-SAFE-CONFIG.md — 任务 03：Shell 安全与配置便携性收口

## 执行摘要

关闭 quality gate 命令注入风险，完成便携配置、安全 update 和 Provider 类型契约一致性，修复所有已知编译/测试失败。

## 独立核对发现的编译错误和 shell:true 矛盾

### 编译错误 (预存，已修复于任务 02)
- `src/adapters/project-adapter.ts(118,7): Cannot find name 'path'` — 任务 02 已在 import 中添加 `isAbsolute`。
- 任务 03 验证：`npm run build` 清洁，0 TypeScript 错误。

### shell:true 矛盾
**问题**：`quality-gate-runner.ts` 注释声称 "shell execution is never allowed"，但 `requiresWindowsShim()` 对 npm/npx/pnpm/yarn/tsx/tsc 返回 `true`，导致 `shell: true` 被传递给 `execFileSync`。此时 Node.js 将 args 连接为命令字符串交由 cmd.exe 解释，args 中的 shell 元字符会被执行。

**修复**：
1. 移除所有 `shell: true` 路径 — `execFileSync` 始终以 `shell: false` 运行
2. `resolveExecutable()` 重写为两步策略：
   - 非 shim 命令（`node`, `python`, `cargo`, `git` 等）→ 原样传递
   - 已知 shim（`npm`, `npx`, `pnpm`, `yarn`）→ 解析为 Node.js 安装目录下的 JS 入口点，以 `node <entry.js>` argv 模式执行
   - `tsx`/`tsc` → fail-closed（推荐使用 `npx tsx` / `npx tsc`）

### Windows 包管理器的无 shell 执行策略

| 命令 | 解析入口 | 状态 |
|------|---------|------|
| `npm` | `<node_dir>/node_modules/npm/bin/npm-cli.js` | ✅ JS 入口 |
| `npx` | `<node_dir>/node_modules/npm/bin/npx-cli.js` | ✅ JS 入口 |
| `pnpm` | `<node_dir>/node_modules/pnpm/bin/pnpm.cjs` | ✅ JS 入口 |
| `yarn` | `<node_dir>/node_modules/yarn/bin/yarn.js` | ✅ JS 入口 |
| `tsx` | n/a | ❌ fail-closed，推荐 `npx tsx` |
| `tsc` | n/a | ❌ fail-closed，推荐 `npx tsc` |
| 其他 | 原样传递 | ✅ 非 shim 命令不受影响 |

所有包管理器均通过 `process.execPath`（node.exe）以 argv 向量模式执行，args 永不进入 shell 解释器。验证：`npm run "test && echo pwned"` 仅触发 npm "Missing script" 错误，不执行 `echo pwned`。

## Provider 类型表

### Worker（`--worker <type>`）

| 类型 | 状态 | Schema | config-resolver |
|------|------|--------|-----------------|
| `fake` | ✅ 已实现 | ✅ `enum: ["fake", "real-pi"]` | ✅ pickWorkerType() |
| `real-pi` | ✅ 已实现 | ✅ | ✅ |
| 其他 | ❌ fail-closed | ❌ schema 拒绝 | ❌ throw |

### Reviewer（`--reviewer <type>`）

| 类型 | 状态 | Schema | config-resolver |
|------|------|--------|-----------------|
| `local-rule` | ✅ 已实现 | ✅ `enum: ["local-rule", "codex-cli"]` | ✅ pickReviewerType() |
| `codex-cli` | ✅ 已实现 | ✅ | ✅ |
| 其他 | ❌ fail-closed | ❌ schema 拒绝 | ❌ throw |

> 修复：`submit.ts` 中运行时比较 `reviewerType === 'codex'` 以及 CLI help 文本中的 `codex` 均已更正为 `codex-cli`。

## 旧配置迁移方法

已有项目使用旧配置（绝对路径 `projectRoot`）继续兼容，`mergeDefaults` 中的路径解析逻辑：

```typescript
const resolvedRoot = rawProjectRoot === '.' || rawProjectRoot === ''
  ? (configFileDir ? resolve(configFileDir, '..') : resolve(projectRoot))
  : sanitizePath(rawProjectRoot, configFileDir);
```

**便携模式**（推荐）：配置文件中 `"projectRoot": "."` 在加载时自动解析为 `.brainctl/` 的父目录。
**绝对路径模式**（向后兼容）：直接使用 `resolve()` 规范化。

## 修复清单

### P0 — 安全性
| 文件 | 问题 | 修复 |
|------|------|------|
| `src/quality/quality-gate-runner.ts` | shell:true 路径存在，args 经 shell 解释 | 移除 shell:true；shim 命令解析为 JS 入口点 |
| `src/quality/quality-gate-runner.ts` | Windows .cmd 无法无 shell 执行 | JS 入口点解析策略（见上表） |

### P0 — 编译/测试
| 文件 | 问题 | 修复 |
|------|------|------|
| `src/adapters/project-adapter.ts` | projectRoot="." 解析到 .brainctl/ 目录 | 改为 resolve(configFileDir, '..') |
| `src/cli/commands/init.ts` | ESM 中使用 require('node:fs') | 改用 ESM import |

### P1 — 一致性
| 文件 | 问题 | 修复 |
|------|------|------|
| `src/cli/commands/submit.ts` | reviewerType 'codex' 与 Provider 契约不一致 | 更正为 'codex-cli'（3 处） |

## 测试结果

### 定向测试（quality + config + init）
```
tests/quality/command-policy.test.ts     31 passed
tests/quality/quality-gate-runner.test.ts 17 passed  (新增 3：攻击向量全覆盖、no-shell-mode、%VAR% 字面)
tests/core/project-config.test.ts         12 passed  (新增 3：PORTABLE-05/06/07)
tests/cli/project-init.test.ts             4 passed
tests/cli/disposable-fixture.test.ts       1 passed  (npm.cmd → JS 入口后修复)
─────────────────────────────────────────────────
Total:                                    65 passed, 0 failed
```

### 完整套件
```
769 passed, 0 failed
4 pre-existing file-level failures (benchmark suites + acceptance suite — unrelated await syntax error)
0 new regressions
Build: clean
```

## 剩余风险

- **pnpm/yarn JS 入口不存在**：若用户未全局安装 pnpm/yarn，`resolveExecutable` 会传递不存在的文件路径给 `execFileSync`，Node.js 报 ENOENT（而非静默回退为 shell 模式）。
- **tsx/tsc fail-closed**：使用这些命令作为质量门的项目需要改用 `npx tsx` / `npx tsc`。
- **向后兼容**：`projectRoot` 为绝对路径的旧配置继续工作，但若移动项目目录，绝对路径会静默指向错误位置。推荐新项目使用 `"."` 便携模式。
- **quality gate 的 cwd 路径**：未修改，但 `resolveExecutable` 中的 JS 入口路径始终基于 Node.js 安装目录，不随 cwd 变化。对于项目本地工具（如 `node_modules/.bin/tsx`），应使用 `npx` 命令。
- **硬暂停锁无超时**（继承自任务 01/02）：长期不恢复有资源泄漏风险。

## 测试命令

```powershell
# 定向测试
npx vitest run tests/quality/ tests/core/project-config.test.ts tests/cli/project-init.test.ts tests/cli/disposable-fixture.test.ts

# 完整套件
npx vitest run

# 编译检查
npx tsc --noEmit
```
