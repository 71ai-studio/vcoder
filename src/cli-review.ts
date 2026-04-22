/**
 * Headless CLI: run an ECC reviewer agent against a target workspace.
 * Usage:
 *   node dist/cli-review.js <target-dir> [agent-name] [--deep] [--split]
 *
 * Modes:
 *   default  = read-only (read_file, grep, glob)
 *   --deep   = also allow a narrow bash allowlist (tsc, eslint, git, ls, cat)
 *   --split  = security-only: run 5 focused category sub-reviews and merge
 */
import * as path from 'path';
import { ChatMessage, LlmConfig } from './agent/ollama';
import { runAgent } from './agent/loop';
import { ToolContext } from './agent/tools/types';
import { loadEcc, buildSystemPrompt, AgentDef } from './ecc/loader';

const READ_ONLY_AUTO = new Set(['read_file', 'grep', 'glob']);

const BASH_ALLOW: RegExp[] = [
  /^npx\s+tsc(\s|$)/,
  /^npx\s+eslint(\s|$)/,
  /^npm\s+run\s+lint(\s|$)/,
  /^npm\s+run\s+typecheck(\s|$)/,
  /^git\s+(status|diff|log|show|rev-parse|branch|remote)(\s|$)/,
  /^ls(\s|$)/,
  /^cat\s/,
  /^head\s/,
  /^wc\s/,
  /^find\s+\.\s.*-type\s+f/
];

interface SecurityCategory {
  id: string;
  label: string;
  pattern: string;
  hint: string;
}

const SECURITY_CATEGORIES: SecurityCategory[] = [
  {
    id: 'secrets',
    label: 'Hardcoded secrets',
    pattern: '(API_?KEY|apiKey|SECRET|token|password|bearer|authorization)\\s*[:=]\\s*[\'"][^\'"]{8,}',
    hint: 'Any variable assigned a string literal that looks like a credential. Flag every hit — no false negatives on this category.'
  },
  {
    id: 'cmd-injection',
    label: 'Command injection',
    pattern: '(child_process|execSync|spawnSync|\\.exec\\(|\\.spawn\\()',
    hint: 'Look for shell/process APIs where any argument could be user-controlled (req.body, req.query, argv, stdin).'
  },
  {
    id: 'eval-rce',
    label: 'Unsafe eval / RCE',
    pattern: '(\\beval\\s*\\(|new\\s+Function\\s*\\(|vm\\.(runIn|compileFunction))',
    hint: 'Direct code execution from strings. ANY hit is worth investigating.'
  },
  {
    id: 'path-traversal',
    label: 'Path traversal',
    pattern: '(path\\.join|path\\.resolve|fs\\.(read|write|create|append)[A-Za-z]*)',
    hint: 'Look for user-controlled segments flowing into filesystem paths without sanitization (".." checks, allowlists).'
  },
  {
    id: 'weak-crypto',
    label: 'Weak crypto',
    pattern: '(\\bmd5\\b|sha1\\s*\\(|createCipher\\s*\\(|DES\\b|RC4\\b|Math\\.random\\s*\\()',
    hint: 'Insecure hashes, deprecated ciphers, Math.random for tokens/IDs.'
  }
];

function isBashAllowed(cmd: string): boolean {
  return BASH_ALLOW.some((re) => re.test(cmd));
}

function baseLlmConfig(): LlmConfig {
  const apiKey = process.env.VDSX_KEY;
  if (!apiKey) { console.error('Set VDSX_KEY env var.'); process.exit(1); }
  return {
    host: process.env.VDSX_HOST ?? 'http://192.168.1.220:11434',
    model: process.env.VDSX_MODEL ?? 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
    apiKey: apiKey!,
    temperature: 0.1,
    numCtx: 49152,
    maxOutput: 12000
  };
}

function makeCtx(target: string, deep: boolean): ToolContext {
  return {
    workspaceRoot: target,
    approve: async (tool, toolArgs) => {
      if (READ_ONLY_AUTO.has(tool)) return true;
      if (tool === 'bash' && deep) {
        const cmd = String(toolArgs.command ?? '');
        if (isBashAllowed(cmd)) { console.log(`[bash allow] ${cmd}`); return true; }
        console.log(`[bash deny ] ${cmd}`);
        return false;
      }
      console.log(`[deny] ${tool}`);
      return false;
    },
    log: (s) => console.log(`[tool] ${s}`)
  };
}

function baseSystemPrompt(agent: AgentDef): string {
  return [
    buildSystemPrompt(agent, []),
    '',
    '---',
    '# Tool-call format (MANDATORY)',
    'Emit ONE tool call per message using EXACTLY:',
    '<tool_call>',
    '{"name": "tool_name", "arguments": {...}}',
    '</tool_call>',
    'Never output ```bash / ```shell / ```json fences. Never describe what you will do — do it.'
  ].join('\n');
}

async function runOneCategory(
  agent: AgentDef,
  target: string,
  cfg: LlmConfig,
  deep: boolean,
  cat: SecurityCategory
): Promise<string> {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[split] category: ${cat.id} — ${cat.label}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const allowedTools = deep
    ? agent.tools.filter((t) => READ_ONLY_AUTO.has(t) || t === 'bash')
    : agent.tools.filter((t) => READ_ONLY_AUTO.has(t));

  const system = baseSystemPrompt(agent);
  const user = [
    `Security audit — ONE category only: ${cat.label}.`,
    '',
    `Pattern to grep: \`${cat.pattern}\``,
    `Hint: ${cat.hint}`,
    '',
    `Workflow (max 4 tool calls):`,
    `1. grep for the pattern above across the repo. Use { "pattern": "<pattern>", "path": "${target}" }.`,
    `2. Look at the hits. If 0-3 files, read_file the interesting one(s) to verify.`,
    `3. Write the report — one section only, for this category.`,
    '',
    'Report format (exactly):',
    `## ${cat.label}`,
    'Either list findings as:',
    '  • path:line — SEVERITY — 1-line snippet verbatim — 1-line fix',
    'OR write the single line: `NONE OBSERVED`',
    '',
    'Rules: no narration, no next-steps, no other categories. Just scan this one pattern and report.'
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];

  let stopped = false;
  let lastAssistantText = '';
  const started = Date.now();
  let toolCalls = 0;

  await runAgent(messages, {
    cfg,
    allowedTools,
    maxIterations: 6,
    autoApprove: READ_ONLY_AUTO,
    ctx: makeCtx(target, deep),
    onMessage: (m) => {
      if (m.role === 'assistant') {
        if (m.tool_calls?.length) toolCalls += m.tool_calls.length;
        if (m.content) lastAssistantText = m.content;
      }
    },
    onToolCall: (n, a) => console.log(`  [call] ${n}(${JSON.stringify(a).slice(0, 120)})`),
    onToolResult: (n, r) => {
      const p = r.length > 160 ? r.slice(0, 160) + `…[+${r.length - 160}]` : r;
      console.log(`  [result] ${n}: ${p.replace(/\n/g, ' | ')}`);
    },
    shouldStop: () => stopped
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[split] ${cat.id}: ${toolCalls} call(s) in ${elapsed}s`);

  return lastAssistantText || `## ${cat.label}\n(no output)`;
}

async function runSingle(agent: AgentDef, target: string, cfg: LlmConfig, deep: boolean): Promise<void> {
  const allowedTools = deep
    ? agent.tools.filter((t) => READ_ONLY_AUTO.has(t) || t === 'bash')
    : agent.tools.filter((t) => READ_ONLY_AUTO.has(t));
  console.log(`[cli] tools=${allowedTools.join(',')}`);

  const isSecurity = /security|sec-/i.test(agent.name);
  const userPrompt = isSecurity
    ? [
        `Security audit of ${target}.`,
        'RULES: one tool_call per message, no narration, no ```bash fences. Every finding cites real file:line.',
        'Scan all 5 categories (secrets, cmd-injection, eval/RCE, path-traversal, weak-crypto). 8-10 tool calls then stop and write the report.',
        'Report = section per category with findings or "NONE OBSERVED". End with verdict APPROVE/WARN/BLOCK.',
        '',
        'TIP: for thoroughness consider running this with --split to audit each category independently.'
      ].join('\n')
    : deep
      ? [
          `Review the project at ${target}.`,
          '1. read_file package.json. 2. if tsconfig.json exists, bash: npx tsc --noEmit. 3. bash: npm run lint | head -100.',
          '4. read_file the 2 most error-dense files from steps 2-3. 5. report grouped by file with line numbers.',
          'Max 10 calls. No invented issues.'
        ].join('\n')
      : [
          `Quick read-only review of ${target}.`,
          '1. read_file package.json. 2. glob main source tree. 3. grep 2-3 anti-patterns. 4. read_file 2 suspicious files. 5. report.',
          'Max 8 calls.'
        ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: baseSystemPrompt(agent) },
    { role: 'user', content: userPrompt }
  ];

  let stopped = false;
  process.on('SIGINT', () => { stopped = true; });
  const started = Date.now();

  await runAgent(messages, {
    cfg,
    allowedTools,
    maxIterations: deep ? 12 : 10,
    autoApprove: READ_ONLY_AUTO,
    ctx: makeCtx(target, deep),
    onMessage: (m) => {
      if (m.role === 'assistant') {
        const n = m.tool_calls?.length ?? 0;
        const summary = n ? ` [${n} call: ${m.tool_calls!.map((c) => c.function.name).join(', ')}]` : '';
        console.log(`\n=== ASSISTANT${summary} ===`);
        if (m.content) console.log(m.content);
      }
    },
    onToolCall: (n, a) => console.log(`[call] ${n}(${JSON.stringify(a).slice(0, 160)})`),
    onToolResult: (n, r) => {
      const p = r.length > 240 ? r.slice(0, 240) + `…[+${r.length - 240}]` : r;
      console.log(`[result] ${n}: ${p.replace(/\n/g, ' | ')}`);
    },
    shouldStop: () => stopped
  });

  console.log(`\n[cli] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function runSplit(agent: AgentDef, target: string, cfg: LlmConfig, deep: boolean): Promise<void> {
  const overallStart = Date.now();
  const reports: string[] = [];
  for (const cat of SECURITY_CATEGORIES) {
    const out = await runOneCategory(agent, target, cfg, deep, cat);
    reports.push(out.trim());
  }
  const totalElapsed = ((Date.now() - overallStart) / 1000).toFixed(1);

  console.log(`\n\n${'═'.repeat(60)}`);
  console.log(`CONSOLIDATED SECURITY REPORT — ${target}`);
  console.log(`(${SECURITY_CATEGORIES.length} categories in ${totalElapsed}s)`);
  console.log('═'.repeat(60));
  for (const r of reports) {
    console.log('\n' + r);
  }
  const verdict = reports.some((r) => /CRITICAL|HIGH/i.test(r) && !/NONE OBSERVED/i.test(r))
    ? 'BLOCK'
    : reports.some((r) => /MEDIUM/i.test(r) && !/NONE OBSERVED/i.test(r))
      ? 'WARN'
      : 'APPROVE';
  console.log(`\n${'═'.repeat(60)}\nFinal verdict: ${verdict}\n${'═'.repeat(60)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const deep = args.includes('--deep');
  const split = args.includes('--split');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = path.resolve(positional[0] ?? '.');
  const agentName = positional[1] ?? 'typescript-reviewer';
  const eccRoot = process.env.VDSX_ECC_ROOT ?? 'd:/Projects/everything-claude-code';

  console.log(`[cli] target=${target}`);
  console.log(`[cli] agent=${agentName}  deep=${deep}  split=${split}`);

  const bundle = loadEcc([eccRoot], undefined);
  const agent = bundle.agents.find((a) => a.name === agentName);
  if (!agent) {
    console.error(`Agent "${agentName}" not found. Available: ${bundle.agents.map((a) => a.name).join(', ')}`);
    process.exit(1);
  }

  const cfg = baseLlmConfig();

  if (split) {
    if (!/security/i.test(agentName)) {
      console.error('--split is only implemented for security-* agents.');
      process.exit(1);
    }
    await runSplit(agent, target, cfg, deep);
  } else {
    await runSingle(agent, target, cfg, deep);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
