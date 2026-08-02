import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { createDashboardServer } from '../../core/dashboard-server.js';
import { WindowsResourceSampler } from '../../core/resource-sampler.js';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer between 1 and 65535');
  return port;
}

export const dashboardCommand = new Command('dashboard')
  .alias('ui')
  .description('启动仅本机可访问的只读状态台（无审批或写入操作）')
  .option('--host <host>', '监听地址，只允许 127.0.0.1、localhost 或 ::1', '127.0.0.1')
  .option('--port <port>', '监听端口', parsePort, 4317)
  .option('--run-id <run-id>', '只显示指定 Run')
  .option('--project <path>', '项目根目录；用于解析默认数据库路径')
  .option('--db <path>', 'SQLite 状态库路径；优先于 BRAINCTL_SQLITE_PATH')
  .option('--max-parallel-tasks <n>', '状态台并发预算上限', parsePort, 4)
  .action(async (options: { host: string; port: number; runId?: string; maxParallelTasks: number; project?: string; db?: string }) => {
    const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (!allowedHosts.has(options.host)) throw new Error('dashboard is read-only and localhost-only; remote binding is not allowed');
    if (options.maxParallelTasks < 1 || options.maxParallelTasks > 16) throw new Error('max-parallel-tasks must be between 1 and 16');

    const config = readSqliteConfigFromEnv(options.project, options.db);
    if (!existsSync(config.path)) throw new Error('数据库文件尚未创建；请先运行 brainctl db migrate --apply');
    const store = SqliteStateStore.openReadonly(config.path);
    const server = createDashboardServer({
      store,
      sampler: new WindowsResourceSampler(),
      userMaxParallel: options.maxParallelTasks,
      runId: options.runId || null,
      dbPath: config.path,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => resolve());
      });
      console.log(`Bridge 只读状态台: http://${options.host === '::1' ? '[::1]' : options.host}:${options.port}`);
      console.log('按 Ctrl+C 关闭。状态台不提供审批、取消、重试或任何写操作。');
      await new Promise<void>((resolve) => {
        const stop = () => server.close(() => resolve());
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    }
  });
