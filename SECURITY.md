# Security Policy

## Supported version

当前仅维护主分支的最新版本。

## Reporting

请使用托管仓库的 Private Vulnerability Reporting 或 Security Advisory 私密报告漏洞，不要在公开 Issue 中附带凭据、真实项目路径、Provider 输出或可利用细节。

报告建议包含：受影响版本、最小复现、预期影响和建议缓解方式。请先撤销任何可能已暴露的 Token；Bridge 不会要求报告者提供真实密钥。

## Security boundaries

- 真实 Provider 默认必须显式授权，并经过隐私与 95% 理解门。
- Dashboard 只允许绑定 loopback，且没有状态写入接口。
- SQLite 是任务状态唯一来源；Markdown、日志和 Dashboard 不能反向驱动调度。
- 任何跳过范围校验、质量门、审查或合并门的行为都视为安全问题。
