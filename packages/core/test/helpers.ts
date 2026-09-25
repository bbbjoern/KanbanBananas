import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BoardFile } from '../src/index.js';

/** Read every `.md` file under `root` as a BoardFile, byte-exact (UTF-8, BOM kept). */
export function readBoardDir(root: string): BoardFile[] {
  if (!existsSync(root)) return [];
  const files: BoardFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        files.push({ path: relative(root, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export const FIXTURES = join(import.meta.dirname, 'fixtures');
export const CORPUS = join(import.meta.dirname, 'corpus', 'features');
