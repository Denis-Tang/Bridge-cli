# 配置说明

## 环境变量配置

| 变量 | 用途 | 必填 |
|------|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | 是 |
| `BRAINCTL_SQLITE_PATH` | SQLite 数据库文件路径 | 否（有默认值） |

## 数据库配置

本项目使用 **SQLite** 作为本地状态存储后端。使用 Node 24 内置的 `node:sqlite`（无需安装 MySQL 或其他数据库驱动）。

### 默认数据库路径

```text
.brainctl/state/brainctl.sqlite
```

路径相对于项目根目录。可通过 `BRAINCTL_SQLITE_PATH` 环境变量覆盖。

### 首次使用

```powershell
# 创建数据库并执行迁移
npm run brainctl -- db migrate --apply
```

### 数据库迁移

迁移文件位于 `src/state/migrations/sqlite/`，命名格式为 `<版本号>_<名称>.sql`。

迁移命令：

```powershell
# 查看迁移状态
npm run brainctl -- db status

# 预览待执行迁移（不建表）
npm run brainctl -- db migrate --dry-run

# 执行迁移建表
npm run brainctl -- db migrate --apply
```

- 已应用的迁移如果 checksum 发生变化会报错，防止篡改。

### 注意

- `node:sqlite` 是 Node 24 实验特性，会显示 `ExperimentalWarning`。不影响功能。
- MySQL 路线**已弃用**。精简版已移除 `_archive` 中的 MySQL 历史代码；如需追溯，请查看 `backup2\原始完整快照`。

## Worker 与 Reviewer 配置

### Worker 类型

通过 CLI 选项 `--worker <type>` 选择：

- **fake** — 只在显式 `--demo-fixture --demo-file <relative-path>` 的 disposable demo 模式使用；通用入口使用结构化 TaskSpec。
- **real-pi** — 使用真实 Pi CLI（`pi --mode rpc`）执行施工。需要 Pi v0.73.0+。

### Reviewer 类型

通过 CLI 选项 `--reviewer <type>` 选择：

- **local-rule**（默认）— 本地规则审查，检查 .env 变更、冲突标记、敏感内容。不调用外部 API。
- **codex-cli** — 使用真实 Codex CLI 临时只读会话审查 supplied diff；默认参数为 `codex exec --ephemeral --sandbox read-only --ignore-user-config --ignore-rules -`。需要 Codex CLI v0.140.0+。

> 项目配置可冻结 Worker/Reviewer 的命令、参数、模型、超时和并发；run 创建时保存脱敏快照，resume 不会读取后来漂移的项目配置。

### 真实项目门

默认 `--local-run` 只允许 disposable 路径（包含 `.brainctl-dev/`）。对真实项目执行需要显式传：

```powershell
npm run brainctl -- submit "需求" --project "D:/真实项目" --local-run --allow-real-project
```

安全门条件：
1. Git 工作树干净
2. 项目路径存在且为 Git 仓库
3. `allowedPaths` 非空
4. `forbiddenPaths` 非空
5. quality gate 可运行
6. reviewer 可用
7. worker 可用
8. 用户明确授权（`--allow-real-project`）

## API Key 配置

- **`DEEPSEEK_API_KEY`** — 仅从环境变量读取，不写入任何配置文件、日志或 Obsidian 记录
- 使用 `brainctl doctor` 检查 Key 是否存在（只显示"已设置/未设置"，不打印密钥值）

## 全局配置

位置：`.brainctl/config.json`（预留，M1 阶段暂不使用）

```json
{
  "version": 1,
  "databasePath": ".brainctl/state/brainctl.sqlite",
  "obsidianRoot": "<PROJECT_ROOT>",  <!-- 本机绝对路径已脱敏 -->
  "defaultRecordsFolder": "codex-brain-records",
  "maxWorkers": 15,
  "maxHeavyCommands": 3,
  "reserveMemoryGb": 8,
  "reserveMemoryPercent": 25,
  "maxAutomaticReworkRounds": 2,
  "pi": {
    "command": "pi",
    "rpcArgs": ["--mode", "rpc"],
    "sessionRoot": ".brainctl/pi-sessions"
  },
  "codex": {
    "mode": "cli",
    "threadReuse": true
  }
}
```

## 项目接入配置

使用 `brainctl init --project <path>` 默认只预览，不写入。只有显式 `--apply` 才创建配置；已有配置必须使用 `--apply --update`，命令会先打印 diff。该命令只读探测 Git 分支、技术栈和现有脚本，不安装依赖，也不自动修改 `.gitignore`。

配置优先级固定为：CLI 显式参数 > run 创建时 `execution_config_snapshot` > 项目 `.brainctl/project.json` > 安全默认值。未配置目标分支时使用当前 Git 分支；无法探测时阻断。

质量门使用结构化向量，`cwd` 必须位于项目根内，命令不得为空：

每个被调度项目生成 `.brainctl/project.json`：

```json
{
  "schemaVersion": 1,
  "projectId": "my-project",
  "projectRoot": ".",
  "defaultBaseBranch": "release",
  "qualityGates": {
    "task": [
      { "name": "test", "command": "npm", "args": ["test"], "cwd": ".", "timeoutMs": 120000, "stopOnFail": true }
    ],
    "stage": [
      { "name": "build", "command": "npm", "args": ["run", "build"], "cwd": ".", "timeoutMs": 120000, "stopOnFail": true }
    ]
  },
  "worker": {
    "type": "real-pi", "command": "pi", "args": ["--mode", "rpc"],
    "model": "", "timeoutMs": 180000, "maxConcurrency": 4
  },
  "reviewer": {
    "type": "codex-cli", "command": "codex",
    "args": ["exec", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "-"],
    "model": "", "timeoutMs": 300000
  },
  "resourceSampling": { "enabled": false, "intervalMs": 5000, "maxParallelTasks": 4 },
  "sharedLocks": [
    "package.json",
    "package-lock.json",
    "tsconfig.json"
  ],
  "forbiddenPaths": [
    ".env",
    ".env.*",
    "**/*secret*",
    "**/*key*"
  ]
}
```

未知字段、非法类型、绝对/逃逸路径和空命令均 fail closed，并报告具体字段。无质量门的项目不会被静默视为通过。

## 质量门 Shell 安全

质量门一律使用 **argv 向量模式** 执行（`execFileSync` 始终 `shell: false`）。

### Windows .cmd shim 执行策略

| 命令 | 执行方式 | 说明 |
|------|---------|------|
| `npm` | `node <node_dir>/node_modules/npm/bin/npm-cli.js` | JS 入口点 |
| `npx` | `node <node_dir>/node_modules/npm/bin/npx-cli.js` | JS 入口点 |
| `pnpm` | `node <node_dir>/node_modules/pnpm/bin/pnpm.cjs` | JS 入口点 |
| `yarn` | `node <node_dir>/node_modules/yarn/bin/yarn.js` | JS 入口点 |
| `tsx` | ❌ fail-closed | 推荐 `npx tsx` |
| `tsc` | ❌ fail-closed | 推荐 `npx tsc` |

- **永不使用 shell**：args 作为字面值传递，Shell 元字符（`&&`, `||`, `;`, `|`, `>`, `<`, `$()`, `` ` ``, `%VAR%`, `@()` 等）不会被执行。
- **fail-closed**：无法安全执行的 shim 拒绝执行并给出明确错误信息，不回退为 shell 模式。
- **Provider key 隔离**：质量门子进程使用最小化环境变量（仅 `PATH`, `SYSTEMROOT` 等系统变量），不含任何 Provider API key。
