import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ensureVdsxDir, timestamp } from './vdsx-dir';

const MAX_OUTPUT = 200_000;

function run(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, maxBuffer: MAX_OUTPUT * 2, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code: err ? (err as NodeJS.ErrnoException).code ? 1 : (err as { code?: number }).code ?? 1 : 0 });
    });
  });
}

export async function isGitRepo(workspaceRoot: string): Promise<boolean> {
  const r = await run('git rev-parse --is-inside-work-tree', workspaceRoot);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/**
 * Get unified diff of working tree vs HEAD (unstaged + staged).
 * Returns empty string if no changes.
 */
export async function runGitDiff(workspaceRoot: string, base: string = 'HEAD'): Promise<string> {
  if (!(await isGitRepo(workspaceRoot))) return '';
  const r = await run(`git diff ${base}`, workspaceRoot);
  let out = r.stdout;
  if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + '\n[truncated]';
  return out;
}

export async function gitStatus(workspaceRoot: string): Promise<string> {
  if (!(await isGitRepo(workspaceRoot))) return '';
  const r = await run('git status --porcelain', workspaceRoot);
  return r.stdout;
}

/**
 * Persist a diff blob to .vdsx/diffs/<timestamp>.diff and return the workspace-relative path.
 */
export async function saveDiffToVdsx(workspaceRoot: string, diff: string, label: string = 'diff'): Promise<string> {
  const dir = ensureVdsxDir(workspaceRoot, 'diffs');
  const filename = `${label}-${timestamp()}.diff`;
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, diff, 'utf8');
  return path.relative(workspaceRoot, abs).replace(/\\/g, '/');
}
