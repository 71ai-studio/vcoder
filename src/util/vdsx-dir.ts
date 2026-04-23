import * as fs from 'fs';
import * as path from 'path';

/**
 * All agent-generated artifacts (diffs, test files, reports) go under this folder
 * inside the workspace. The folder is auto-added to .gitignore on first ensure.
 */
const GITIGNORE_MARKER = '# vdsx agent-generated files';

export function ensureVdsxDir(workspaceRoot: string, subdir?: string): string {
  const base = path.join(workspaceRoot, '.vdsx');
  const target = subdir ? path.join(base, subdir) : base;
  fs.mkdirSync(target, { recursive: true });
  ensureGitignoreEntry(workspaceRoot);
  return target;
}

export function vdsxPath(workspaceRoot: string, ...segments: string[]): string {
  return path.join(workspaceRoot, '.vdsx', ...segments);
}

function ensureGitignoreEntry(workspaceRoot: string): void {
  const gi = path.join(workspaceRoot, '.gitignore');
  let content = '';
  try { content = fs.readFileSync(gi, 'utf8'); } catch { /* file may not exist */ }
  if (/^\.vdsx\/?\s*$/m.test(content)) return;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  const appended = `${prefix}\n${GITIGNORE_MARKER}\n.vdsx/\n`;
  try {
    fs.writeFileSync(gi, content + appended, 'utf8');
  } catch {
    // workspace may be read-only or non-git — silently skip
  }
}

export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
