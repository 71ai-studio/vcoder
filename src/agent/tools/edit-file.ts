import * as fs from 'fs/promises';
import { ToolHandler } from './types';
import { resolveInside } from './fs-util';

export const editFile: ToolHandler = {
  risky: true,
  schema: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact substring in a file. old_string must occur exactly once. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  async run(args, ctx) {
    const p = String(args.path);
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string ?? '');
    const replaceAll = Boolean(args.replace_all);
    const abs = resolveInside(ctx.workspaceRoot, p);
    const original = await fs.readFile(abs, 'utf8');
    if (!original.includes(oldStr)) throw new Error(`old_string not found in ${p}`);
    if (!replaceAll) {
      const first = original.indexOf(oldStr);
      const last = original.lastIndexOf(oldStr);
      if (first !== last) throw new Error(`old_string occurs more than once in ${p}; pass replace_all=true or extend context.`);
    }
    const ok = await ctx.approve('edit_file', { path: p, replaceAll });
    if (!ok) return 'User denied edit_file.';
    const updated = replaceAll ? original.split(oldStr).join(newStr) : original.replace(oldStr, newStr);
    await fs.writeFile(abs, updated, 'utf8');
    return `Edited ${p}`;
  }
};
