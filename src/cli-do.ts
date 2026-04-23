/**
 * Headless CLI wrapper around the orchestrator.
 * Usage: VDSX_KEY=<key> node dist/cli-do.js <workspace-dir> "<goal>" [--auto-approve]
 */
import * as path from 'path';
import * as readline from 'readline';
import { LlmConfig } from './agent/ollama';
import { ToolContext } from './agent/tools/types';
import { orchestrate, planToMarkdown, Plan } from './agent/orchestrator';
import { loadEcc } from './ecc/loader';
import { loadContextFiles, resolvePhaseAgents } from './ecc/context-files';

async function askYN(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + ' [y/N] ', (ans) => { rl.close(); resolve(/^y/i.test(ans.trim())); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const autoApprove = args.includes('--auto-approve');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = path.resolve(positional[0] ?? '.');
  const goal = positional.slice(1).join(' ').trim();
  if (!goal) { console.error('Usage: cli-do <workspace> "<goal>" [--auto-approve]'); process.exit(1); }

  const apiKey = process.env.VDSX_KEY;
  if (!apiKey) { console.error('Set VDSX_KEY'); process.exit(1); }

  const cfg: LlmConfig = {
    host: process.env.VDSX_HOST ?? 'http://192.168.1.220:11434',
    model: process.env.VDSX_MODEL ?? 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
    apiKey,
    temperature: 0.1,
    numCtx: 49152,
    maxOutput: 12000
  };

  console.log(`[cli-do] target=${target}`);
  console.log(`[cli-do] goal=${goal}`);

  // Load ECC bundle + context files
  const eccRoot = process.env.VDSX_ECC_ROOT ?? 'd:/Projects/everything-claude-code';
  const bundle = loadEcc([eccRoot], undefined);
  const contextFiles = loadContextFiles(target, ['CLAUDE.md', 'AGENTS.md']);
  const phaseAgents = resolvePhaseAgents(bundle, {
    plan: process.env.VDSX_PLAN_AGENT ?? 'planner',
    execute: process.env.VDSX_EXECUTE_AGENT ?? 'code-architect',
    fix: process.env.VDSX_FIX_AGENT ?? 'build-error-resolver'
  });
  console.log(`[cli-do] phase agents: ${Object.keys(phaseAgents).filter((k) => phaseAgents[k]).join(', ') || '(none)'}`);
  console.log(`[cli-do] context files: ${contextFiles ? `${contextFiles.length} bytes` : '(none)'}`);

  const ctx: ToolContext = {
    workspaceRoot: target,
    approve: async () => true,
    log: (s) => console.log(`[log] ${s}`)
  };

  let stopped = false;
  process.on('SIGINT', () => { stopped = true; console.error('\n[SIGINT]'); });

  let currentStreamPhase: string | null = null;
  await orchestrate(
    {
      cfg,
      goal,
      ctx,
      maxFixAttempts: 3,
      phaseAgents,
      contextFiles,
      onStreamStart: (phase) => {
        currentStreamPhase = phase;
        process.stdout.write(`\n╭─ stream [${phase}] ─╮\n`);
      },
      onStreamChunk: (_phase, delta) => {
        process.stdout.write(delta);
      },
      onStreamEnd: (_phase, _text) => {
        process.stdout.write(`\n╰─ end [${currentStreamPhase}] ─╯\n`);
        currentStreamPhase = null;
      },
      shouldStop: () => stopped
    },
    {
      onPhase: (phase, info) => console.log(`\n── ${phase} ── ${info ?? ''}`),
      onPlan: async (plan: Plan) => {
        console.log('\n' + planToMarkdown(plan) + '\n');
        if (autoApprove) { console.log('[auto-approve]'); return true; }
        return await askYN('Approve plan?');
      },
      onReport: (md) => console.log('\n' + md + '\n'),
      shouldStop: () => stopped
    }
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
