import * as vscode from 'vscode';
import { ChatMessage, LlmConfig, chat, probe } from '../agent/ollama';
import { runAgent } from '../agent/loop';
import { ToolContext } from '../agent/tools/types';
import { loadEcc, buildSystemPrompt, AgentDef, EccBundle } from '../ecc/loader';
import { loadContextFiles, resolvePhaseAgents } from '../ecc/context-files';
import { orchestrate, planToMarkdown, Plan } from '../agent/orchestrator';
import { breakdownMessages, estimateTokens, formatBreakdown } from '../agent/token-estimate';
import { getSchemas } from '../agent/tools/registry';

type Mode = 'chat' | 'workflow';

interface IncomingMsg {
  type: 'send' | 'stop' | 'selectAgent' | 'reloadEcc' | 'setMode' | 'clearHistory';
  text?: string;
  agent?: string;
  mode?: Mode;
}

export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ecc: EccBundle = { agents: [], commands: [], rules: [] };
  private currentAgent: AgentDef | null = null;
  private histories: Record<Mode, ChatMessage[]> = { chat: [], workflow: [] };
  private logs: Record<Mode, unknown[]> = { chat: [], workflow: [] };
  private stopFlag = false;
  private mode: Mode = 'workflow';

  private get history(): ChatMessage[] {
    return this.histories[this.mode];
  }

  private historyStrategy(): 'auto-clear' | 'separate' {
    const cfg = vscode.workspace.getConfiguration('vdsx');
    return (cfg.get<string>('modeHistory', 'auto-clear') === 'separate' ? 'separate' : 'auto-clear');
  }

  private isRenderable(msg: unknown): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const t = (msg as { type?: string }).type;
    return t === 'user' || t === 'assistant' || t === 'toolCall' || t === 'toolResult' || t === 'info' || t === 'phase' || t === 'error';
  }

  private replayLog() {
    // Direct webview post to avoid re-tracking into logs
    this.panel.webview.postMessage({ type: 'clearLog' });
    for (const m of this.logs[this.mode]) {
      this.panel.webview.postMessage(m);
    }
  }

  private clearCurrentState() {
    this.histories[this.mode] = [];
    this.logs[this.mode] = [];
  }

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
    if (msg.type === 'setMode' && msg.mode) {
      if (msg.mode === this.mode) return; // no-op on same mode
      const prev = this.mode;
      this.mode = msg.mode;
      const strategy = this.historyStrategy();
      if (strategy === 'separate') {
        // Restore target mode's saved log via replay.
        this.replayLog();
        const prior = this.history.length;
        this.post({
          type: 'info',
          text: `Mode: ${this.mode === 'chat' ? 'Chat' : 'Workflow'} · separate history (${prior} prior msg${prior === 1 ? '' : 's'} restored).`
        });
      } else {
        // auto-clear: both modes start fresh on every switch
        this.histories[prev] = [];
        this.logs[prev] = [];
        this.histories[this.mode] = [];
        this.logs[this.mode] = [];
        this.panel.webview.postMessage({ type: 'clearLog' });
        this.post({
          type: 'info',
          text: `Mode: ${this.mode === 'chat' ? 'Chat (pure conversation, no tools)' : 'Workflow (tools + /do orchestrator)'} · history cleared (auto-clear).`
        });
      }
      return;
    }
    if (msg.type === 'clearHistory') {
      this.clearCurrentState();
      this.panel.webview.postMessage({ type: 'clearLog' });
      this.post({ type: 'info', text: `Conversation cleared (${this.mode} mode).` });
      return;
    }
    if (msg.type === 'selectAgent') {
      this.currentAgent = this.ecc.agents.find((a) => a.name === msg.agent) ?? null;
      this.clearCurrentState();
      this.panel.webview.postMessage({ type: 'clearLog' });
      this.post({ type: 'agentChanged', name: this.currentAgent?.name ?? '' });
      this.post({ type: 'info', text: this.currentAgent ? `Agent: ${this.currentAgent.name}` : 'Agent cleared.' });
      return;
    }
    if (msg.type === 'stop') { this.stopFlag = true; return; }
    if (msg.type === 'send' && msg.text) {
      this.stopFlag = false;
      const trimmed = msg.text.trim();
      const isDo = trimmed.toLowerCase().startsWith('/do ');
      const isHelp = trimmed.toLowerCase() === '/help' || trimmed === '/?';
      if (isHelp) {
        this.post({ type: 'info', text: 'Modes:\n  Chat     — pure conversation, no tools, no file access.\n  Workflow — tools (read/write/edit/bash/grep/glob) + /do <goal> orchestrator.\n\nCommands (Workflow only):\n  /do <goal>  — plan → execute → test → fix → report' });
        return;
      }
      if (isDo) {
        if (this.mode !== 'workflow') {
          this.post({ type: 'info', text: '/do is only available in Workflow mode. Switch mode via toolbar.' });
          return;
        }
        await this.runDo(trimmed.slice(4).trim());
        return;
      }
      if (this.mode === 'chat') {
        await this.runChat(trimmed);
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
        {
          cfg: llmCfg,
          goal,
          ctx,
          maxFixAttempts: 3,
          phaseAgents,
          contextFiles,
          onLlmCall: (phase, msgs, schemas) => {
            const bd = breakdownMessages(msgs);
            const st = estimateTokens(JSON.stringify(schemas));
            this.post({ type: 'info', text: `[${phase}] ${formatBreakdown(bd, st, llmCfg.numCtx)}` });
          }
        },
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

  private async runChat(userText: string) {
    const llmCfg = this.buildLlmConfig();
    if (!llmCfg) return;
    const cfg = vscode.workspace.getConfiguration('vdsx');

    const probeErr = await probe(llmCfg);
    if (probeErr) { this.post({ type: 'error', text: probeErr }); return; }

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    // Chat mode system prompt: agent persona (if any) + workspace context, NO rules, NO tool instructions.
    const agent = this.currentAgent;
    const contextPaths = cfg.get<string[]>('contextFiles', ['CLAUDE.md', 'AGENTS.md']);
    const contextFiles = loadContextFiles(ws, contextPaths);
    const systemParts = [
      agent
        ? agent.systemPrompt
        : 'You are a helpful coding assistant. Answer concisely. You do NOT have file or shell access — if the user needs those, tell them to switch to Workflow mode.'
    ];
    if (contextFiles) systemParts.push('---\n# Workspace context\n\n' + contextFiles);
    const system = systemParts.join('\n\n');

    if (this.history.length === 0) {
      this.history.push({ role: 'system', content: system });
    }
    this.history.push({ role: 'user', content: userText });
    this.post({ type: 'user', text: userText });

    // Phase-0 instrumentation
    const preBudget = breakdownMessages(this.history);
    this.post({ type: 'info', text: 'pre-call ' + formatBreakdown(preBudget, 0, llmCfg.numCtx) });

    try {
      if (this.stopFlag) return;
      const reply = await chat(llmCfg, this.history, []);
      this.history.push(reply);
      if (reply.content) this.post({ type: 'assistant', text: reply.content });
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }

    const postBudget = breakdownMessages(this.history);
    const delta = postBudget.total - preBudget.total;
    this.post({ type: 'info', text: `post-call ${formatBreakdown(postBudget, 0, llmCfg.numCtx)} (Δ +${delta} tok this turn)` });
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

    // Phase-0 instrumentation: log input budget before LLM call
    const schemaTokens = estimateTokens(JSON.stringify(getSchemas(allowedTools)));
    const preBudget = breakdownMessages(this.history);
    this.post({ type: 'info', text: 'pre-call ' + formatBreakdown(preBudget, schemaTokens, llmCfg.numCtx) });

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
        onToolResult: (n, r) => {
          const toks = estimateTokens(r);
          this.post({ type: 'info', text: `tool ${n} → ${r.length} bytes (~${toks} tok)` });
          this.post({ type: 'toolResult', name: n, result: r.length > 4000 ? r.slice(0, 4000) + '\n[...truncated for UI]' : r });
        },
        shouldStop: () => this.stopFlag
      });
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }

    // Phase-0 instrumentation: log final history size after tool results + assistant responses
    const postBudget = breakdownMessages(this.history);
    const delta = postBudget.total - preBudget.total;
    this.post({ type: 'info', text: `post-call ${formatBreakdown(postBudget, schemaTokens, llmCfg.numCtx)} (Δ +${delta} tok this turn)` });
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

  private post(msg: unknown) {
    if (this.isRenderable(msg)) this.logs[this.mode].push(msg);
    this.panel.webview.postMessage(msg);
  }

  private dispose() {
    ChatPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    margin: 0; padding: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    font-size: 13px;
  }

  /* Top tabs (CHAT | WORKFLOW) */
  #tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 0 8px;
    flex-shrink: 0;
  }
  .tab {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: none;
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.6px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    position: relative;
    top: 1px;
    outline: none;
  }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background));
  }
  .tab:hover:not(.active) { color: var(--vscode-foreground); }

  /* Title bar */
  #titleBar {
    padding: 10px 14px;
    font-size: 13px;
    color: var(--vscode-foreground);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  #titleText { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #titleRight { display: flex; gap: 4px; }
  .icon-btn {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 4px 7px;
    border-radius: 3px;
    font-size: 14px;
    line-height: 1;
  }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--vscode-foreground); }

  /* Message area */
  #log {
    flex: 1;
    overflow-y: auto;
    padding: 0 14px 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg { padding: 6px 10px; margin: 6px 0; border-radius: 4px; }
  .msg .label {
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 3px;
    letter-spacing: 0.5px;
  }
  .user { background: var(--vscode-textBlockQuote-background); }
  .assistant { background: rgba(100,150,250,0.08); }
  .tool { background: rgba(200,150,50,0.08); font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .result { background: rgba(100,200,100,0.06); font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .error { background: rgba(250,100,100,0.12); }
  .info { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 2px 4px; }
  .info .label { display: none; }

  /* Composer (bottom input area) */
  #composer { flex-shrink: 0; padding: 6px 12px 12px; }
  #composerBox {
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 8px;
    background: var(--vscode-input-background);
    display: flex;
    flex-direction: column;
    transition: border-color 0.15s;
  }
  #composerBox:focus-within { border-color: var(--vscode-focusBorder); }
  #input {
    background: transparent;
    color: var(--vscode-input-foreground);
    border: none;
    outline: none;
    resize: none;
    min-height: 44px;
    max-height: 200px;
    padding: 10px 12px;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    width: 100%;
  }
  #composerFooter {
    display: flex;
    align-items: center;
    padding: 4px 6px 6px;
    gap: 4px;
  }
  .footer-btn {
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 8px;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    font-family: var(--vscode-font-family);
  }
  .footer-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--vscode-foreground); }
  .footer-spacer { flex: 1; }
  #agentChip {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    margin-left: 4px;
  }
  #modeChip {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  #modeChip:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  #sendBtn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    font-weight: 600;
  }
  #sendBtn:hover { background: var(--vscode-button-hoverBackground); }
  #sendBtn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Popup menu */
  .popup {
    position: fixed;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    border-radius: 6px;
    padding: 4px;
    min-width: 240px;
    max-height: 70vh;
    overflow-y: auto;
    box-shadow: 0 6px 16px rgba(0,0,0,0.3);
    z-index: 100;
    display: none;
  }
  .popup.show { display: block; }
  .popup .section {
    padding: 8px 10px 4px;
    font-size: 10px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.5px;
  }
  .popup .item {
    padding: 7px 10px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .popup .item:hover { background: var(--vscode-list-hoverBackground); }
  .popup .item .desc {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    margin-left: auto;
  }
  .popup .item .check { margin-left: auto; color: var(--vscode-focusBorder, var(--vscode-button-background)); }
  .popup .divider { height: 1px; background: var(--vscode-panel-border); margin: 4px 2px; }
  .popup .empty { padding: 8px 10px; color: var(--vscode-descriptionForeground); font-size: 12px; font-style: italic; }
</style>
</head><body>
  <div id="tabs" role="tablist" aria-label="Mode">
    <button class="tab" role="tab" data-mode="chat">CHAT</button>
    <button class="tab active" role="tab" data-mode="workflow">WORKFLOW</button>
  </div>

  <div id="titleBar">
    <span id="titleText">VDS-X session</span>
    <div id="titleRight">
      <button class="icon-btn" id="actionsBtn" title="Actions">⋯</button>
    </div>
  </div>

  <div id="log"></div>

  <div id="composer">
    <div id="composerBox">
      <textarea id="input" placeholder="Ask or instruct... (Ctrl+Enter to send)"></textarea>
      <div id="composerFooter">
        <button class="footer-btn" id="plusBtn" title="Add context">+</button>
        <button class="footer-btn" id="slashBtn" title="Slash commands & modes">/</button>
        <span id="agentChip" style="display:none"></span>
        <div class="footer-spacer"></div>
        <span id="modeChip" title="Click to switch">Workflow</span>
        <button class="footer-btn" id="stopBtn" title="Stop generation">◼</button>
        <button id="sendBtn" title="Send (Ctrl+Enter)">↑</button>
      </div>
    </div>
  </div>

  <!-- Actions menu (⋯ in title bar) -->
  <div class="popup" id="actionsMenu">
    <div class="section">CONTEXT</div>
    <div class="item" data-action="clear">🗑️ Clear conversation</div>
    <div class="item" data-action="reload">⟳ Reload ECC</div>
  </div>

  <!-- + menu (composer) -->
  <div class="popup" id="plusMenu">
    <div class="section">ADD CONTEXT</div>
    <div class="item" data-action="clear">🗑️ Clear conversation</div>
    <div class="item" data-action="reload">⟳ Reload ECC definitions</div>
  </div>

  <!-- / menu (composer) -->
  <div class="popup" id="slashMenu">
    <div class="section">MODES</div>
    <div class="item" data-mode="chat">💬 Chat <span class="desc">pure conversation</span></div>
    <div class="item" data-mode="workflow">⚡ Workflow <span class="desc">tools + /do</span></div>
    <div class="divider"></div>
    <div class="section">AGENT</div>
    <div id="agentList"></div>
    <div class="divider"></div>
    <div class="section">COMMANDS</div>
    <div class="item" data-insert="/do ">/do &lt;goal&gt; <span class="desc">orchestrator</span></div>
    <div class="item" data-insert="/help">/help <span class="desc">list options</span></div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const agentChip = document.getElementById('agentChip');
  const modeChip = document.getElementById('modeChip');
  const agentList = document.getElementById('agentList');

  let currentMode = 'workflow';
  let currentAgent = '';

  function add(cls, label, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    if (label) {
      const h = document.createElement('div');
      h.className = 'label';
      h.textContent = label;
      d.appendChild(h);
    }
    const b = document.createElement('div');
    b.textContent = text;
    d.appendChild(b);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  function setActiveTab(mode) {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-mode') === mode);
    });
    modeChip.textContent = mode === 'chat' ? 'Chat' : 'Workflow';
    currentMode = mode;
  }

  function refreshAgentList(agents) {
    agentList.innerHTML = '';
    const none = document.createElement('div');
    none.className = 'item';
    none.setAttribute('data-agent', '');
    none.textContent = '(no agent — default)';
    if (!currentAgent) { const c = document.createElement('span'); c.className = 'check'; c.textContent = '✓'; none.appendChild(c); }
    agentList.appendChild(none);
    if (agents.length === 0) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No ECC agents found. Add .md files under .claude/agents/';
      agentList.appendChild(e);
      return;
    }
    agents.forEach((a) => {
      const d = document.createElement('div');
      d.className = 'item';
      d.setAttribute('data-agent', a.name);
      d.textContent = a.name;
      if (a.description) { const s = document.createElement('span'); s.className = 'desc'; s.textContent = a.description.slice(0, 40); d.appendChild(s); }
      if (a.name === currentAgent) { const c = document.createElement('span'); c.className = 'check'; c.textContent = '✓'; d.appendChild(c); }
      agentList.appendChild(d);
    });
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'user') add('user', 'You', m.text);
    else if (m.type === 'assistant') add('assistant', 'Assistant', m.text);
    else if (m.type === 'toolCall') add('tool', 'Tool call: ' + m.name, JSON.stringify(m.args, null, 2));
    else if (m.type === 'toolResult') add('result', 'Result: ' + m.name, m.result);
    else if (m.type === 'info') add('info', '', m.text);
    else if (m.type === 'phase') add('info', '', 'Phase ' + m.phase + (m.info ? ': ' + m.info : ''));
    else if (m.type === 'error') add('error', 'Error', m.text);
    else if (m.type === 'clearLog') { log.innerHTML = ''; }
    else if (m.type === 'agentChanged') {
      currentAgent = m.name || '';
      if (currentAgent) { agentChip.style.display = ''; agentChip.textContent = currentAgent; }
      else { agentChip.style.display = 'none'; agentChip.textContent = ''; }
      refreshAgentList(window.__lastAgents || []);
    }
    else if (m.type === 'ecc') {
      window.__lastAgents = m.agents;
      refreshAgentList(m.agents);
    }
  });

  // Tabs — click to switch mode
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      const mode = t.getAttribute('data-mode');
      if (mode === currentMode) return;
      setActiveTab(mode);
      vscode.postMessage({ type: 'setMode', mode });
    });
  });

  // Popups — show/hide with outside click dismissal
  const popups = { actions: document.getElementById('actionsMenu'), plus: document.getElementById('plusMenu'), slash: document.getElementById('slashMenu') };
  function hideAll() { Object.values(popups).forEach((p) => p.classList.remove('show')); }
  function toggle(popup, anchor, above) {
    const isOpen = popup.classList.contains('show');
    hideAll();
    if (isOpen) return;
    const r = anchor.getBoundingClientRect();
    popup.classList.add('show');
    // position: above=below anchor's top edge going up; else below anchor
    if (above) {
      popup.style.left = r.left + 'px';
      popup.style.top = '';
      popup.style.bottom = (window.innerHeight - r.top + 4) + 'px';
    } else {
      popup.style.left = (r.right - 240) + 'px';
      popup.style.top = (r.bottom + 4) + 'px';
      popup.style.bottom = '';
    }
  }

  document.getElementById('plusBtn').addEventListener('click', (e) => { e.stopPropagation(); toggle(popups.plus, e.currentTarget, true); });
  document.getElementById('slashBtn').addEventListener('click', (e) => { e.stopPropagation(); toggle(popups.slash, e.currentTarget, true); });
  document.getElementById('actionsBtn').addEventListener('click', (e) => { e.stopPropagation(); toggle(popups.actions, e.currentTarget, false); });
  modeChip.addEventListener('click', (e) => { e.stopPropagation(); toggle(popups.slash, e.currentTarget, true); });
  document.addEventListener('click', hideAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideAll(); });

  // Menu item click dispatch
  document.querySelectorAll('.popup').forEach((popup) => {
    popup.addEventListener('click', (e) => {
      const item = e.target.closest('.item');
      if (!item) return;
      e.stopPropagation();
      const action = item.getAttribute('data-action');
      const mode = item.getAttribute('data-mode');
      const agent = item.getAttribute('data-agent');
      const insert = item.getAttribute('data-insert');
      if (action === 'clear') vscode.postMessage({ type: 'clearHistory' });
      else if (action === 'reload') vscode.postMessage({ type: 'reloadEcc' });
      else if (mode) {
        if (mode !== currentMode) { setActiveTab(mode); vscode.postMessage({ type: 'setMode', mode }); }
      }
      else if (agent !== null) {
        vscode.postMessage({ type: 'selectAgent', agent: agent });
      }
      else if (insert) { input.value = insert; input.focus(); }
      hideAll();
    });
  });

  document.getElementById('sendBtn').addEventListener('click', send);
  document.getElementById('stopBtn').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  // Auto-grow textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  function send() {
    const t = input.value.trim();
    if (!t) return;
    vscode.postMessage({ type: 'send', text: t });
    input.value = '';
    input.style.height = 'auto';
  }

  // Initial focus
  input.focus();
</script>
</body></html>`;
  }
}
