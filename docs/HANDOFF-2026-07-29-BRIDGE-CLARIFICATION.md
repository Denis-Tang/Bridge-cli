# 2026-07-29 bridge 与 Pi 95% 理解门交接

## 结论

Skill 已统一改名为 `bridge`。真实 Pi 入口现默认执行同一临时 session 内的只读理解协议：最多两轮“Pi 提问 → Codex 自动回答技术问题”，第二轮回答后允许一次不计新答疑轮数的最终只读确认；只有理解度至少 95%、无遗留问题且无受保护分类时才开放施工工具。

需求选择、隐私、费用扩大和范围变化必须暂停给用户。结构化输出异常、Codex 失败、超时、回答数量不匹配或两轮后仍低于 95% 都失败闭锁，不进入质量门、审查或合并。

## 核心实现

- `src/adapters/pi-clarification.ts`：结构化协议、分类、95% 判定、问答提示与施工上下文。
- `src/adapters/codex-technical-clarifier.ts`：只读 Codex 技术答疑和受保护决策闭锁。
- `src/adapters/pi-rpc-worker.ts`：同 session 多回合、只读工具切换、Provider 用量合计和有界 session 清理重试。
- `src/adapters/windows-cli-resolver.ts`：Windows 下按 PATH 顺序解析原生 exe 或 npm cmd 的本地 JS 入口，不调用 shell。
- `src/core/stage-scheduler.ts`、`src/cli/commands/submit.ts`：所有正常真实 Pi 入口默认开启理解门；注入测试 runner 仅在显式配置时开启。

## 验证证据

- `npm run check`：构建和 69 个测试文件、930 项测试通过。
- 精确协议测试覆盖同 session、只读到施工切换、两轮后 94% 暂停、受保护分类、Codex 非结构化输出、Windows npm shim 和延迟 session 写入清理。
- 真实 disposable：`run_1785259962920`。
  - Pi 先按任务要求提出纯技术问题，Codex 自动回答；日志元数据确认 2 个只读理解回合。
  - 达到 95% 后，Pi 仅把 `output.txt` 改为 `BRIDGE_READY` 并提交。
  - scope 仅 `output.txt`；`npm test` 通过；真实 Codex CLI 审查通过；合并 commit `6250cf19581d568987bb664315c8512e73bc4a59`。
  - 主仓库 clean，无 `brainctl/*` 分支，仅保留主 worktree。
  - 成功运行 Provider 聚合用量 41,456 tokens、0.00184078 USD。
- 前序故障调用：
  - `run_1785259533658` 在 Windows CLI 启动前失败，无 Provider 用量。
  - `run_1785259823781` 完成首轮只读 Pi 后因 Codex app alias `EPERM` 闭锁；确认用量 16,057 tokens、0.0009700992 USD；无文件改动。
  - 三次合计可确认 DeepSeek 费用 0.0028108792 USD，按 7.5 粗略折算约人民币 0.0211 元；Codex CLI 无可靠结构化 token，保持 unavailable。

## 隐私与清理

真实 Provider stdout 未写入文件；日志仅保存长度、哈希和数字用量。真实测试发现一次 Pi session 延迟重建残留，新增有界重试并用延迟写入回归覆盖；实际残留已通过新清理器删除。最终应继续删除 disposable fixture，不保留原始运行会话。

## 剩余边界

- sequential baseline 仍未执行，不能宣称固定 Codex Token 节省比例。
- Codex 技术答疑与审查的实际 token 仍为 unavailable。
- 多人生产或长期无人值守仍需更多真实长任务样本。
