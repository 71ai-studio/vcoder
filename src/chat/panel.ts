import * as vscode from 'vscode';
import { ChatMessage, LlmConfig, probe } from '../agent/ollama';
import { runAgent } from '../agent/loop';
import { ToolContext } from '../agent/tools/types';
import { loadEcc, buildSystemPrompt, AgentDef, EccBundle } from '../ecc/loader';
import { loadContextFiles, resolvePhaseAgents } from '../ecc/context-files';
import { orchestrate, planToMarkdown, Plan } from '../agent/orchestrator';

interface IncomingMsg {
  type: 'send' | 'stop' | 'selectAgent' | 'reloadEcc';
  text?: string;
  agent?: string;
}

export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ecc: EccBundle = { agents: [], commands: [], rules: [] };
  private currentAgent: AgentDef | null = null;
  private history: ChatMessage[] = [];
  private stopFlag = false;

  static show(context: vscode.ExtensionContext) {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'vdsxChat',
      'VDS-X Chat',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ChatPanel.current = new ChatPanel(panel, context);
  }

  constructor(panel: vscode.WebviewPanel, private context: vscode.ExtensionContext) {
    this.panel = panel;
    this.panel.webview.html = this.html();
    this.reloadEcc();

    this.panel.webview.onDidReceiveMessage(
      (m: IncomingMsg) => this.onIncoming(m),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  reloadEcc() {
    const cfg = vscode.workspace.getConfiguration('vdsx');
    const roots = cfg.get<string[]>('eccPaths', ['.claude', '~/.claude']);
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.ecc = loadEcc(roots, ws);
    this.post({
      type: 'ecc',
      agents: this.ecc.agents.map((a) => ({ name: a.name, description: a.description })),
      commands: this.ecc.commands.map((c) => ({ name: c.name, description: c.description })),
      ruleCount: this.ecc.rules.length
    });
    this.post({ type: 'info', text: `Loaded ${this.ecc.agents.length} agents, ${this.ecc.commands.length} commands, ${this.ecc.rules.length} rules.` });
  }

  private async onIncoming(msg: IncomingMsg) {
    if (msg.type === 'reloadEcc') { this.reloadEcc(); return; }
    if (msg.type === 'selectAgent') {
      this.currentAgent = this.ecc.agents.find((a) => a.name === msg.agent) ?? null;
      this.history = [];
      this.post({ type: 'info', text: this.currentAgent ? `Agent: ${this.currentAgent.name}` : 'Agent cleared.' });
      return;
    }
    if (msg.type === 'stop') { this.stopFlag = true; return; }
    if (msg.type === 'send' && msg.text) {
      this.stopFlag = false;
      const trimmed = msg.text.trim();
      if (trimmed.toLowerCase().startsWith('/do ')) {
        await this.runDo(trimmed.slice(4).trim());
      } else if (trimmed.toLowerCase() === '/help' || trimmed === '/?') {
        this.post({ type: 'info', text: 'Commands:\n  /do <goal>  — plan → execute → test → fix → report\n  (anything else) — chat turn with the selected agent' });
      } else {
        await this.runTurn(trimmed);
      }
    }
  }

  private buildLlmConfig(): LlmConfig | null {
    const cfg = vscode.workspace.getConfiguration('vdsx');
    const apiKey = cfg.get<string>('ollama.apiKey', '');
    if (!apiKey) {
      this.post({ type: 'error', text: 'vdsx.ollama.apiKey is not set. Add it to VSCode settings.' });
      return null;
    }
    return {
      host: cfg.get<string>('ollama.host', 'http://192.168.1.220:11434'),
      model: cfg.get<string>('ollama.model', 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf'),
      apiKey,
      numCtx: cfg.get<number>('ollama.numCtx', 49152),
      temperature: cfg.get<number>('ollama.temperature', 0.2),
      maxOutput: cfg.get<number>('ollama.maxOutput', 12000)
    };
  }

  private async runDo(goal: string) {
    if (!goal) { this.post({ type: 'error', text: 'Usage: /do <goal>' }); return; }
    const llmCfg = this.buildLlmConfig();
    if (!llmCfg) return;

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { this.post({ type: 'error', text: 'Open a workspace folder first.' }); return; }

    const probeErr = await probe(llmCfg);
    if (probeErr) { this.post({ type: 'error', text: probeErr }); return; }

    this.post({ type: 'user', text: `/do ${goal}` });

    // All tools auto-approved during a /do run — user approves the PLAN, not each edit.
    const ctx: ToolContext = {
      workspaceRoot: ws,
      approve: async () => true,
      log: (s) => this.post({ type: 'info', text: s })
    };

    const vscfg = vscode.workspace.getConfiguration('vdsx');
    const contextPaths = vscfg.get<string[]>('contextFiles', ['CLAUDE.md', 'AGENTS.md']);
    const contextFiles = loadContextFiles(ws, contextPaths);
    const phaseMapping = vscfg.get<Record<string, string>>('phaseAgents', {
      plan: 'planner',
      execute: 'code-architect',
      fix: 'build-error-resolver'
    });
    const phaseAgents = resolvePhaseAgents(this.ecc, phaseMapping);
    const loadedAgents = Object.entries(phaseAgents).filter(([, v]) => v).map(([k]) => k);
    if (loadedAgents.length) this.post({ type: 'info', text: `Phase agents loaded: ${loadedAgents.join(', ')}` });
    if (contextFiles) this.post({ type: 'info', text: `Context files loaded (${contextFiles.length} bytes)` });

    try {
      await orchestrate(
        { cfg: llmCfg, goal, ctx, maxFixAttempts: 3, phaseAgents, contextFiles },
        {
          onPhase: (phase, info) => this.post({ type: 'phase', phase, info: info ?? '' }),
          onPlan: async (plan: Plan) => {
            this.post({ type: 'assistant', text: planToMarkdown(plan) });
            const pick = await vscode.window.showInformationMessage(
              `VDS-X plan: ${plan.summary}\n\n${plan.tasks.length} tasks · test: ${plan.test_command}`,
              { modal: true },
              'Approve',
              'Reject'
            );
            return pick === 'Approve';
          },
          onReport: (md) => this.post({ type: 'assistant', text: md }),
          shouldStop: () => this.stopFlag
        }
      );
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  private async runTurn(userText: string) {
    const llmCfg = this.buildLlmConfig();
    if (!llmCfg) return;
    const cfg = vscode.workspace.getConfiguration('vdsx');

    const probeErr = await probe(llmCfg);
    if (probeErr) { this.post({ type: 'error', text: probeErr }); return; }

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const maxIter = cfg.get<number>('maxIterations', 20);
    const autoApprove = new Set(cfg.get<string[]>('autoApprove', ['read_file', 'grep', 'glob']));

    // Build system prompt
    const agent = this.currentAgent;
    const contextPaths = cfg.get<string[]>('contextFiles', ['CLAUDE.md', 'AGENTS.md']);
    const contextFiles = loadContextFiles(ws, contextPaths);
    const systemParts = [
      agent
        ? buildSystemPrompt(agent, this.ecc.rules)
        : [
            'You are VDS-X, a local coding agent running inside VSCode.',
            'You have file tools (read_file, write_file, edit_file), shell (bash), and search (grep, glob).',
            'Call tools to inspect and modify the workspace. Be concise.'
          ].join('\n')
    ];
    if (contextFiles) systemParts.push('---\n# Workspace context\n\n' + contextFiles);
    const system = systemParts.join('\n\n');

    if (this.history.length === 0) {
      this.history.push({ role: 'system', content: system });
    }
    this.history.push({ role: 'user', content: userText });
    this.post({ type: 'user', text: userText });

    const ctx: ToolContext = {
      workspaceRoot: ws,
      approve: (tool, args) => this.askApproval(tool, args),
      log: (s) => this.post({ type: 'info', text: s })
    };

    const allowedTools = agent && agent.tools.length > 0 ? agent.tools : null;

    try {
      await runAgent(this.history, {
        cfg: llmCfg,
        allowedTools,
        maxIterations: maxIter,
        autoApprove,
        ctx,
        onMessage: (m) => {
          if (m.role === 'assistant' && m.content) this.post({ type: 'assistant', text: m.content });
        },
        onToolCall: (n, a) => this.post({ type: 'toolCall', name: n, args: a }),
        onToolResult: (n, r) => this.post({ type: 'toolResult', name: n, result: r.length > 4000 ? r.slice(0, 4000) + '\n[...truncated for UI]' : r }),
        shouldStop: () => this.stopFlag
      });
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  private async askApproval(tool: string, args: Record<string, unknown>): Promise<boolean> {
    const summary = JSON.stringify(args).slice(0, 200);
    const pick = await vscode.window.showWarningMessage(
      `VDS-X wants to run ${tool}(${summary})`,
      { modal: true },
      'Allow',
      'Deny'
    );
    return pick === 'Allow';
  }

  private post(msg: unknown) { this.panel.webview.postMessage(msg); }

  private dispose() {
    ChatPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); padding: 8px; margin: 0; }
  #toolbar { display:flex; gap:8px; align-items:center; padding:4px 0 8px; border-bottom:1px solid var(--vscode-panel-border); }
  #log { white-space: pre-wrap; word-break: break-word; padding:8px 0; height: calc(100vh - 170px); overflow-y:auto; }
  .msg { padding:6px 8px; margin:6px 0; border-radius:4px; }
  .user { background: var(--vscode-textBlockQuote-background); }
  .assistant { background: rgba(100,150,250,0.1); }
  .tool { background: rgba(200,150,50,0.1); font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .result { background: rgba(100,200,100,0.08); font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .error { background: rgba(250,100,100,0.15); }
  .info { color: var(--vscode-descriptionForeground); font-size: 12px; }
  #input { width:100%; min-height:70px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); padding:6px; font-family:var(--vscode-font-family); }
  button, select { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor:pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .label { font-weight:600; font-size:11px; text-transform:uppercase; color: var(--vscode-descriptionForeground); margin-bottom:2px; }
</style>
</head><body>
<div id="toolbar">
  <select id="agentSel"><option value="">(no agent — default)</option></select>
  <button id="reloadBtn" class="secondary">Reload ECC</button>
  <button id="stopBtn" class="secondary">Stop</button>
</div>
<div id="log"></div>
<textarea id="input" placeholder="Ask or instruct... (Ctrl+Enter to send)"></textarea>
<div style="display:flex;justify-content:flex-end;margin-top:6px;"><button id="sendBtn">Send</button></div>

<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const agentSel = document.getElementById('agentSel');

  function add(cls, label, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    const h = document.createElement('div');
    h.className = 'label';
    h.textContent = label;
    d.appendChild(h);
    const b = document.createElement('div');
    b.textContent = text;
    d.appendChild(b);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'user') add('user', 'You', m.text);
    else if (m.type === 'assistant') add('assistant', 'Assistant', m.text);
    else if (m.type === 'toolCall') add('tool', 'Tool call: ' + m.name, JSON.stringify(m.args, null, 2));
    else if (m.type === 'toolResult') add('result', 'Result: ' + m.name, m.result);
    else if (m.type === 'info') add('info', 'Info', m.text);
    else if (m.type === 'phase') add('info', 'Phase ' + m.phase, m.info || '');
    else if (m.type === 'error') add('error', 'Error', m.text);
    else if (m.type === 'ecc') {
      agentSel.innerHTML = '<option value="">(no agent — default)</option>' + m.agents.map((a) => '<option value="' + a.name + '">' + a.name + '</option>').join('');
    }
  });

  document.getElementById('sendBtn').addEventListener('click', send);
  document.getElementById('stopBtn').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  document.getElementById('reloadBtn').addEventListener('click', () => vscode.postMessage({ type: 'reloadEcc' }));
  agentSel.addEventListener('change', () => vscode.postMessage({ type: 'selectAgent', agent: agentSel.value }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  function send() {
    const t = input.value.trim();
    if (!t) return;
    vscode.postMessage({ type: 'send', text: t });
    input.value = '';
  }
</script>
</body></html>`;
  }
}
