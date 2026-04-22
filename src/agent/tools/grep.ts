import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolHandler } from './types';
import { resolveInside } from './fs-util';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vscode-test', '.next', '.turbo']);
const MAX_FILES = 5000;
const MAX_MATCHES = 200;
const MAX_LINE_LEN = 180;
const MAX_OUTPUT_BYTES = 10_000;

async function walk(root: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_FILES) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return;
    if (e.name.startsWith('.') && e.name !== '.env') {
      if (IGNORE_DIRS.has(e.name)) continue;
    }
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) await walk(full, acc);
    else if (e.isFile()) acc.push(full);
  }
}

export const grep: ToolHandler = {
  risky: false,
  schema: {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search workspace files for a regex pattern. Returns matching lines with file:line prefix. Skips node_modules, .git, build dirs.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regex pattern.' },
          path: { type: 'string', description: 'Subdirectory to search (default: workspace root).' },
          glob: { type: 'string', description: 'Optional file extension filter, e.g. ".ts" or ".py".' },
          case_insensitive: { type: 'boolean' }
        },
        required: ['pattern']
      }
    }
  },
  async run(args, ctx) {
    const patternStr = String(args.pattern);
    const sub = args.path ? resolveInside(ctx.workspaceRoot, String(args.path)) : ctx.workspaceRoot;
    const ext = args.glob ? String(args.glob) : '';
    const flags = args.case_insensitive ? 'i' : '';
    const re = new RegExp(patternStr, flags);

    const files: string[] = [];
    await walk(sub, files);

    const hits: string[] = [];
    for (const f of files) {
      if (ext && !f.endsWith(ext)) continue;
      let text: string;
      try {
        text = await fs.readFile(f, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const trimmed = lines[i].trim();
          const snippet = trimmed.length > MAX_LINE_LEN ? trimmed.slice(0, MAX_LINE_LEN) + '…' : trimmed;
          hits.push(`${path.relative(ctx.workspaceRoot, f)}:${i + 1}: ${snippet}`);
          if (hits.length >= MAX_MATCHES) break;
        }
      }
      if (hits.length >= MAX_MATCHES) break;
    }
    let out = hits.length ? hits.join('\n') : '(no matches)';
    if (out.length > MAX_OUTPUT_BYTES) {
      out = out.slice(0, MAX_OUTPUT_BYTES) + `\n[truncated: ${hits.length} total matches, refine pattern to narrow]`;
    }
    return out;
  }
};
