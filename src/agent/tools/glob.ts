import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolHandler } from './types';
import { resolveInside } from './fs-util';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vscode-test', '.next', '.turbo']);
const MAX_FILES = 2000;

// Minimal glob: supports **, *, ?
function globToRegExp(glob: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^$()|[]{}\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

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
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) await walk(full, acc);
    else if (e.isFile()) acc.push(full);
  }
}

export const glob: ToolHandler = {
  risky: false,
  schema: {
    type: 'function',
    function: {
      name: 'glob',
      description: 'List workspace files matching a glob pattern (supports *, **, ?).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'e.g. "src/**/*.ts"' },
          path: { type: 'string', description: 'Root to search (default: workspace root).' }
        },
        required: ['pattern']
      }
    }
  },
  async run(args, ctx) {
    const patternStr = String(args.pattern);
    const sub = args.path ? resolveInside(ctx.workspaceRoot, String(args.path)) : ctx.workspaceRoot;
    const re = globToRegExp(patternStr);
    const files: string[] = [];
    await walk(sub, files);
    const matches = files
      .map((f) => path.relative(ctx.workspaceRoot, f).replace(/\\/g, '/'))
      .filter((f) => re.test(f));
    return matches.length ? matches.join('\n') : '(no matches)';
  }
};
