#!/usr/bin/env node

import { Command } from 'commander';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { submitCommand } from './commands/submit.js';
import { statusCommand } from './commands/status.js';
import { approveCommand } from './commands/approve.js';
import { resumeCommand } from './commands/resume.js';
import { cancelCommand } from './commands/cancel.js';
import { dbCommand } from './commands/db.js';
import { configCommand } from './commands/config.js';
import { revokeCommand } from './commands/revoke.js';
import { auditCommand } from './commands/audit.js';
import { reconcileCommand } from './commands/reconcile.js';
import { privacyCommand } from './commands/privacy.js';

const program = new Command();

program
  .name('brainctl')
  .description('Codex Brain + Pi Worker 多代理施工调度系统 CLI')
  .version('0.1.0');

program.addCommand(doctorCommand);
program.addCommand(initCommand);
program.addCommand(submitCommand);
program.addCommand(statusCommand);
program.addCommand(approveCommand);
program.addCommand(resumeCommand);
program.addCommand(cancelCommand);
program.addCommand(dbCommand);
program.addCommand(configCommand);
program.addCommand(revokeCommand);
program.addCommand(auditCommand);
program.addCommand(reconcileCommand);
program.addCommand(privacyCommand);

program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
