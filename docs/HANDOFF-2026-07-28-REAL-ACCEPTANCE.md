# 2026-07-28 真实运行验收交接

## 结论

项目已达到私人 Windows 环境基本稳定可用：fake/disposable 全量验收通过，真实 DeepSeek Pi、Codex CLI、scope、Corepack pnpm 质量门、merge 与 worktree 清理完成闭环。尚未做 sequential baseline，因此不宣称已证明相对纯 Codex 的 Token 节省比例。

## 真实施工

1. Glue 安全审计 L2：为 smoke 窗口尺寸增加 7680×4320 上限，抽取纯函数并新增 17 项测试。首轮 Pi 已提交，但因当时 pnpm 解析问题停在质量门；修复后复用原提交，质量门和真实 Codex Reviewer 通过并合并。
2. Glue 审查跟进：仅把 `main.ts` 的长 import 改为多行。完整 `brainctl submit --local-run` 7/7 阶段一次通过，合并 commit 为 `8bb9050294be893301cbed7e1c6f6c6dd8766e0d`。
3. 写回真实 Glue 前已核对目标文件与 disposable 基线 blob，确认没有漂移；只写回 3 个 L2 文件。真实 Glue 精确测试 17/17 通过，原有 17 个 UI 工作树改动全部保留，未 commit、未 push。

## 费用与计量

- DeepSeek Flash 健康检查：423 input、19 output、442 total，0.00006454 USD，约 0.000484 元。
- 完整自动链：13,215 input、3,319 output、241,280 cacheRead、257,814 total，0.003455004 USD，约 0.025913 元。
- 可确认合计约 0.026397 元。首项 L2 Pi 调用发生在 Provider 用量持久化修复前，日志被截断，无法恢复实际费用，必须保持 unavailable；不得伪造精确总额。
- Codex CLI 使用 ChatGPT 登录，当前 runner 无结构化 token 回传，ledger 应标记 unavailable。

## 本轮修复的真实缺陷

- Provider 子进程环境未按模型最小化；Codex 会继承 Provider key。
- Windows pnpm 错误解析为非 Corepack 路径。
- Pi ledger 信任 Worker 自报；local-run 不显示 Provider 确认用量。
- Pi/Codex 日志保存原始输出、diff、提示词和失败 stderr。
- Codex 旧 reviewer 参数会加载持久配置且首次审查超时。
- Git 注销 worktree 后，Windows 长路径依赖目录无法完成删除。
- reconciliation report ID 只使用 `Date.now()`，同毫秒重复恢复会碰撞 SQLite 唯一键；现改为时间戳加 UUID，原失败用例连续 5 次通过。

## 最终验证

- 最终 `npm run check`：构建通过，67 个测试文件、920 项测试，退出码 0；修复恢复 ID 碰撞后再次全量通过。
- 真实 Glue：17/17 精确测试通过；3 个目标 blob 与已审查 disposable 完全一致。
- 完整自动链：Pi → scope → quality gate → Codex review → merge 全部通过；无残留 branch/worktree。
- 项目扫描未发现用户编号、QQ 邮箱、用户名或真实个人绝对路径；疑似 key/email 命中均位于脱敏与 Git 测试夹具。

## 剩余边界

- 要量化节省效果，仍需同任务 sequential baseline。
- 要宣称长期生产成熟，建议继续积累 10—20 次真实长任务与故障样本。
- Node 24 `node:sqlite` 仍会输出 experimental warning，需保持运行时版本固定。
