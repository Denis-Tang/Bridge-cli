# 配置说明

支持运行时固定为 Node.js 24.x（`>=24.0.0 <25.0.0`）。`brainctl doctor`、package engines 与 CI 使用同一区间；Node 22 不在支持范围。

## 环境变量配置

| 变量 | 用途 | 必填 |
|------|------|------|
| `DEEPSEEK_API_KEY` | 仅真实 DeepSeek Pi Provider 使用 | 否（fake/本地检查不需要） |
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
- 每个迁移 SQL 与对应 `schema_migrations` 记录在同一事务中提交；任一句失败都会回滚该版本，避免“结构已变但版本未记”或相反状态。

### 注意

- `node:sqlite` 是 Node 24 实验特性，会显示 `ExperimentalWarning`。不影响功能。
- MySQL 路线**已弃用**。精简版已移除 `_archive` 中的 MySQL 历史代码；如需追溯，请查看 `backup2\原始完整快照`。

## Worker 与 Reviewer 配置

### Worker 类型

通过 CLI 选项 `--worker <type>` 选择：

- **fake** — 只在显式 `--demo-fixture --demo-file <relative-path>` 的 disposable demo 模式使用；通用入口使用结构化 TaskSpec。
- **real-pi** — 使用真实 Pi CLI（`pi --mode rpc`）执行施工。当前只读澄清强制已验证 Pi v0.82.1；升级版本必须重新验证原生工具 allowlist 和 pre-execution 事件语义。

### Reviewer 类型

通过 CLI 选项 `--reviewer <type>` 选择：

- **local-rule**（默认）— 本地规则审查，检查 .env 变更、冲突标记、敏感内容。不调用外部 API。
- **codex-cli** — 使用真实 Codex CLI 临时只读会话审查 supplied diff；默认参数为 `codex exec --ephemeral --sandbox read-only --ignore-user-config --ignore-rules -`。需要 Codex CLI v0.140.0+。

> 项目配置可冻结 Worker/Reviewer 的命令、参数、模型、超时和并发；run 创建时保存脱敏快照，resume 不会读取后来漂移的项目配置。

真实 Pi 施工前默认启用 95% 理解门。澄清子进程禁用自动扩展、Skill、prompt template 和项目 AGENTS/context，只允许原生 `--tools read,grep,find,ls`；一次性 `tool_call` guard 在执行前阻断非只读、worktree 外、forbidden、凭据和非授权上下文路径。最多两轮技术答疑后再做一次最终确认，未达到阈值即暂停。

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

执行模式默认是 `token-efficient`。可在 `submit/plan`、`approve/run` 或 `resume` 使用 `--execution-mode default|simple|token-efficient` 覆盖；显式 `default` 保留逐任务审查的兼容行为。

质量门使用结构化向量，`cwd` 必须位于项目根内，命令不得为空：

每个被调度项目生成 `.brainctl/project.json`：

```json
{
  "schemaVersion": 1,
  "projectId": "my-project",
  "projectRoot": ".",
  "defaultBaseBranch": "release",
  "executionMode": "token-efficient",
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
  "costBudget": {
    "limit": 20,
    "maxPiCallCost": 2,
    "maxCodexCallCost": 1
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

真实 Pi 或 Codex Provider 需要 `costBudget`。`costBudget` 的数值是**无单位的最坏单次调用配额**，不含 `currency` / `pricingVersion`：`limit` 是该 Run 的调用配额上限，`maxPiCallCost` / `maxCodexCallCost` 是调用前原子预留的最坏单次配额。缺少配置、预留失败或余额不足时不会启动 Provider；无法获得可信实际用量时保留整笔预留并标记用量未知。该账本用于 Bridge 硬门和恢复判断，不替代 Provider 官方账单。

### 调用配额预留心跳与人工核销（代码/库表沿用 `cost_*` 旧名）

> 说明：配额语义下的「预留」机制在源码与 SQLite 中仍沿用历史标识符（`cost_reservations` 表、`reserveCost` / `settleCost`、`budget` CLI、`costReservationHeartbeatMs` 等）。这些是内部命名，不代表货币金额；数值一律按无单位配额解释。

- **心跳**：Pi worker 与 Codex reviewer 执行期间，预留的 `lease_expires_at` 按 lease 窗口的 1/3 或更短周期自动续期（lease 窗口 = `max(workerTimeoutMs, 120s) + 60s`），避免长调用被陈旧回收器误判。心跳写库失败只记录、不中断 worker（sink failure 不改变业务语义）。心跳间隔是内部实现细节，默认由 lease 窗口推导，不暴露为项目配置项；测试通过 `SchedulerConfig.costReservationHeartbeatMs` 注入覆盖。
- **人工核销**：进程被 SIGKILL 后无法结算的预留会停在 `unavailable`，永久占用配额。用 `brainctl budget write-off --reservation <id> --decision-note "<原因>"` 显式核销（只允许 `unavailable`；`reserved`/`spawned` 一律拒绝，防止误核销在跑调用）。核销后该预留不再计入 remaining，状态变为 `written_off` 终态。**账目语义**：`released` = 证明未消耗配额（未产生调用）；`written_off` = 可能已消耗配额但用户决定不再占用——两者在查询中可区分，审计事件记录预留、理由与时间。
- 先看后销：`brainctl budget list --status unavailable` 只读盘点后再决定核销。Dashboard 保持只读，无任何写端点。

### Pi guard 运行时自检（`worker.verifiedPiVersion`）

真实 Pi 澄清会话开始前（每 run/每版本缓存一次）会跑一个**零推理探针**：加载同构探针扩展，验证扩展真的被加载、`pi.on('tool_call')` 真的注册成功、事件系统真的触发（`session_start`）。探针进程用 `--mode rpc --offline --no-session` 加立即 EOF 的 stdin，不发任何 prompt——**不产生任何模型推理、不消耗调用配额**。任何信号缺失即 fail closed：拒绝启动该澄清会话（暂停并明确告知可能是 Pi CLI 版本变更）。

- `worker.verifiedPiVersion`（默认 `0.82.1`）是已验证的 Pi CLI 版本。检测到实际版本不匹配时输出**显著警告**，但不会直接拒绝运行——探针必须通过才继续；升级 Pi 后如探针通过，可更新此版本号。
- 自检结果（通过/失败、Pi 版本、耗时、失败类别、stderr SHA-256）写入 SQLite 事件 `pi_guard_selfcheck` 并出现在 `brainctl status`。**不持久化原始 Provider 输出、完整提示词或 stderr 原文**。
- **诚实边界**：自检验证的是"扩展被加载 + handler 已注册 + 事件系统存活"，**不验证端到端的真实工具调用阻断**（那需要至少一次推理；方案见三轮汇总，需显式授权与调用配额预留后执行）。

### B：阻断语义端到端探针（一次最小推理，已授权待首次执行）

`worker.allowInferenceProbe: true` 时，A 自检通过后会对**未缓存**的 Pi 版本跑一次最小推理探针：在隔离探针目录请求一个**必定越界**的 `read` 调用，验证 guard 真的在 `tool_call` 阶段拦截（violation marker 出现）。

- **配额消耗**：一次最小推理（默认 `deepseek/deepseek-v4-flash`），**必须走调用配额预留硬门**（`reserveCost` → 探针 → `settleCost`），绝不标免费或绕过 ledger。
- **缓存**：按 `pi --version` 完整版本持久化到 SQLite（`pi_guard_probe_cache` 表）；同版本已通过即复用，不再消耗配额。
- **失败分类（处置不同）**：
  - `guard_ineffective`（收到响应但 `tool_execution_start` 越界事件出现，第一层未拦截）→ **guard 失效**，fail closed 拒绝启动澄清会话；
  - `provider_unavailable`（限流/网络/余额/认证）→ 报**"无法验证"**并暂停（不是 guard 失效），结算为 `released`；
  - `probe_timeout` / `inconclusive`（模型未发起工具调用）→ 报"无法验证"并暂停，结算为 `unavailable`。
- **首次执行**：即使已配置，第一次真实发起前必须由用户显式同意（agent 会停下说明"即将发起一次消耗调用配额 X 的推理探针"）。
- 零推理、不消耗调用配额的 A 自检始终执行；B 是 A 之上的加强，不是替代。

非注入的真实 `worker.type=real-pi` 必须搭配 `reviewer.type=codex-cli`。`local-rule` 仅供 fake/disposable 验证，不能批准真实 Pi 成果。

`sharedLocks` 是受保护路径清单，不会再无条件追加到每个任务。只有当任务 `estimatedWritePaths` 与受保护路径相同或存在父子包含关系时，才会获取对应互斥锁；任务自己的预计写路径始终加锁。

## 已有提交恢复

`brainctl recover attempt` 只用于已有可验证 commit 的最新 attempt。命令先以只读方式加载 Run 保存的配置快照，完成 commit/branch/worktree、项目与任务 forbiddenPaths、项目 allowedPaths、`git diff --check` 和任务质量门检查；失败时不迁移或改写 SQLite。

冻结 TaskSpec 之外、Run 项目 `allowedPaths` 之内的文件必须同时提供 `--allow-scope-expansion` 和非空 `--decision-note`。原子接纳会把 Attempt/Task 置为 `worker_completed`，记录稳定的变更/扩展 SHA-256，并锁定预计路径、实际变更路径及与它们重叠的 `sharedLocks`。`resume` 会复核 adopted commit、branch、实际 diff、摘要和全部锁，只复用本次精确批准的扩展；证据漂移会保持 Stage 暂停。恢复不代表 Review、集成或 Run 完成。

## 只读状态台

```powershell
npm run brainctl -- dashboard --run-id <run-id>
```

状态台只允许 loopback 地址，数据来自 SQLite `StatusSnapshot`，没有写入、批准、取消或重试端点。状态库使用 `{ readOnly: true, timeout }`、`PRAGMA query_only=ON` 和 `busy_timeout` 打开；Dashboard 不执行迁移。可用 `--project <path>` 或 `--db <path>` 定位状态库，使用 `--port` 改端口，不能绑定外网地址。恢复、批准和 resume 必须在 CLI 完成。

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
