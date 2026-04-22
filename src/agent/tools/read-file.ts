import * as fs from 'fs/promises';
import { ToolHandler } from './types';
import { resolveInside } from './fs-util';

const MAX_BYTES = 12_000;   // ~3k tokens — fits tight inside 32k ctx across multiple reads
const DEFAULT_LIMIT = 400;  // lines

export const readFile: ToolHandler = {
  risky: false,
  schema: {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Read a UTF-8 text file. Returns at most ${MAX_BYTES} bytes / ${DEFAULT_LIMIT} lines. Use offset+limit to page through large files.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
          offset: { type: 'number', description: 'Optional 0-based line offset.' },
          limit: { type: 'number', description: `Optional max lines (default ${DEFAULT_LIMIT}).` }
        },
        required: ['path']
      }
    }
  },
  async run(args, ctx) {
    const p = String(args.path);
    const abs = resolveInside(ctx.workspaceRoot, p);
    const raw = await fs.readFile(abs, 'utf8');
    const lines = raw.split('\n');
    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const sliced = lines.slice(offset, offset + limit);
    let out = sliced.join('\n');
    const totalLines = lines.length;
    let note = '';
    if (out.length > MAX_BYTES) {
      out = out.slice(0, MAX_BYTES);
      note = `\n\n[truncated: ${raw.length} bytes / ${totalLines} lines total. Re-read with offset/limit for more.]`;
    } else if (offset + sliced.length < totalLines) {
      note = `\n\n[showing lines ${offset}-${offset + sliced.length} of ${totalLines}. Use offset=${offset + sliced.length} to continue.]`;
    }
    return out + note;
  }
};
