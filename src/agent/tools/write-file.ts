import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolHandler } from './types';
import { resolveInside } from './fs-util';

export const writeFile: ToolHandler = {
  risky: true,
  schema: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file, overwriting if it exists. Creates parent directories as needed. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  async run(args, ctx) {
    const p = String(args.path);
    const content = String(args.content ?? '');
    const abs = resolveInside(ctx.workspaceRoot, p);
    const ok = await ctx.approve('write_file', { path: p, bytes: content.length });
    if (!ok) return 'User denied write_file.';
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return `Wrote ${content.length} bytes to ${p}`;
  }
};
