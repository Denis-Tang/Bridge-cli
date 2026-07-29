import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

export interface ResolvedCliCommand {
  command: string;
  args: string[];
  source: 'unchanged' | 'native-exe' | 'npm-shim';
}

/**
 * Resolve bare Windows CLI names without invoking cmd.exe.
 * Prefer a native .exe. For npm .cmd shims, parse the local JS entry point and
 * launch it with the current Node executable. No shell text is executed.
 */
export function resolveWindowsCliCommand(
  command: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): ResolvedCliCommand {
  if (platform !== 'win32') return { command, args, source: 'unchanged' };

  const extension = extname(command).toLowerCase();
  if (extension === '.exe' || extension === '.com') return { command, args, source: 'unchanged' };

  const pathEntries = (env.PATH || env.Path || env.path || '')
    .split(';')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  let shim: string | undefined;
  if (!isAbsolute(command) && !command.includes('\\') && !command.includes('/')) {
    for (const dir of pathEntries) {
      const native = resolve(dir, `${command}.exe`);
      if (existsSync(native)) return { command: native, args, source: 'native-exe' };
      const candidate = resolve(dir, `${command}.cmd`);
      if (existsSync(candidate)) {
        shim = candidate;
        break;
      }
    }
  } else {
    const candidate = extension === '.cmd' ? command : `${command}.cmd`;
    if (existsSync(candidate)) shim = candidate;
  }
  if (!shim) return { command, args, source: 'unchanged' };

  try {
    const content = readFileSync(shim, 'utf8');
    const matches = [...content.matchAll(/%dp0%\\([^"\r\n]*node_modules\\[^"\r\n]+)/gi)];
    const relativeEntry = matches.at(-1)?.[1];
    if (!relativeEntry) return { command, args, source: 'unchanged' };
    const entry = resolve(shim, '..', relativeEntry);
    if (!existsSync(entry)) return { command, args, source: 'unchanged' };
    return { command: process.execPath, args: [entry, ...args], source: 'npm-shim' };
  } catch {
    return { command, args, source: 'unchanged' };
  }
}
