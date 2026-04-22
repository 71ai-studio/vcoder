import { spawn } from 'child_process';
import { ToolHandler } from './types';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 8_000; // keep tight so multiple bash calls don't blow 32k ctx

export const bash: ToolHandler = {
  risky: true,
  schema: {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command in the workspace root. Uses cmd.exe on Windows, /bin/sh elsewhere. Output is truncated to 32KB. Requires approval.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number', description: 'Max runtime in ms (default 120000).' }
        },
        required: ['command']
      }
    }
  },
  async run(args, ctx) {
    const cmd = String(args.command);
    const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
    const ok = await ctx.approve('bash', { command: cmd });
    if (!ok) return 'User denied bash.';

    return await new Promise<string>((resolve) => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWin ? ['/c', cmd] : ['-c', cmd];
      const child = spawn(shell, shellArgs, { cwd: ctx.workspaceRoot, env: process.env });

      let out = '';
      let err = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill();
      }, timeout);

      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const combined = [
          `exit code: ${killed ? 'TIMEOUT' : code}`,
          out ? `--- stdout ---\n${out}` : '',
          err ? `--- stderr ---\n${err}` : ''
        ].filter(Boolean).join('\n');
        resolve(combined.length > MAX_OUTPUT ? combined.slice(0, MAX_OUTPUT) + '\n[truncated]' : combined);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve(`error: ${e.message}`);
      });
    });
  }
};
