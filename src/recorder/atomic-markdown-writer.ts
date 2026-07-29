import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Atomic Markdown Writer - writes markdown files using temp file + atomic rename.
 * Prevents partial writes on crash.
 */
export class AtomicMarkdownWriter {
  async write(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = filePath + '.tmp.' + Date.now();
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
  }
}
