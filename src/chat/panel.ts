import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage, LlmConfig, chat, probe } from '../agent/ollama';
import { runAgent } from '../agent/loop';
import { ToolContext } from '../agent/tools/types';
import { loadEcc, buildSystemPrompt, AgentDef, EccBundle } from '../ecc/loader';
import { loadContextFiles, resolvePhaseAgents } from '../ecc/context-files';
import { orchestrate, planToMarkdown, Plan } from '../agent/orchestrator';
import { breakdownMessages, estimateTokens, formatBreakdown } from '../agent/token-estimate';
import { getSchemas } from '../agent/tools/registry';
import { ensureVdsxDir, timestamp } from '../util/vdsx-dir';
import { runGitDiff, saveDiffToVdsx, isGitRepo } from '../util/git-helpers';

type Mode = 'chat' | 'workflow';
type PermMode = 'ask' | 'auto-edit' | 'plan' | 'auto' | 'bypass';
type OutputLang = 'en' | 'vi' | 'ja';

interface Attachment {
  path: string;
  type: 'file' | 'folder';
}

interface ModelEntry {
  label: string;
  model: string;
  host?: string;
  apiKey?: string;
  numCtx?: number;
  temperature?: number;
  maxOutput?: number;
}

interface IncomingMsg {
  type:
    | 'send' | 'stop' | 'selectAgent' | 'reloadEcc' | 'setMode' | 'clearHistory'
    | 'addActiveFile' | 'addActiveFolder' | 'removeAttachment'
    | 'openPermPicker' | 'setPermMode'
    | 'openLanguagePicker' | 'setLanguage'
    | 'openModelPicker' | 'setModel'
    | 'toggleThinking';
  text?: string;
  agent?: string;
  mode?: Mode;
  value?: string;
}

const PERM_LABELS: Record<PermMode, string> = {
  'ask': 'Ask before edits',
  'auto-edit': 'Edit automatically',
  'plan': 'Plan mode',
  'auto': 'Auto mode',
  'bypass': 'Bypass permissions'
};

const LANG_NAMES: Record<OutputLang, string> = {
  'en': 'English',
  'vi': 'Vietnamese',
  'ja': 'Japanese'
};

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
  private attachments: Attachment[] = [];
  private permMode: PermMode = 'ask';
  private outputLang: OutputLang = 'en';
  private thinking: boolean = false;
  private modelOverride: ModelEntry | null = null;

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
    // Stream events are transient UI directives — not tracked. Final assistant msg is tracked separately.
    return t === 'user' || t === 'assistant' || t === 'toolCall' || t === 'toolResult' || t === 'info' || t === 'phase' || t === 'error';
  }

  // Post a stream event directly to webview without log tracking
  private streamStart(phase?: string) {
    this.panel.webview.postMessage({ type: 'assistantStart', phase });
  }
  private streamChunk(delta: string) {
    this.panel.webview.postMessage({ type: 'assistantChunk', delta });
  }
  private streamEnd() {
    this.panel.webview.postMessage({ type: 'assistantEnd' });
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

    // Load defaults from config
    const cfg = vscode.workspace.getConfiguration('vdsx');
    this.permMode = (cfg.get<string>('defaultPermissionMode', 'ask') as PermMode);
    this.outputLang = (cfg.get<string>('outputLanguage', 'en') as OutputLang);

    this.reloadEcc();

    // Post initial UI state
    this.panel.webview.postMessage({ type: 'permModeChanged', label: PERM_LABELS[this.permMode] });
    this.panel.webview.postMessage({ type: 'languageChanged', value: this.outputLang });
    this.panel.webview.postMessage({ type: 'thinkingChanged', value: this.thinking });
    this.panel.webview.postMessage({ type: 'modelChanged', label: '' });

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

    // UI-driven configuration actions
    if (msg.type === 'addActiveFile') { this.addActiveFile(); return; }
    if (msg.type === 'addActiveFolder') { this.addActiveFolder(); return; }
    if (msg.type === 'removeAttachment') {
      const idx = parseInt(msg.value ?? '', 10);
      if (!isNaN(idx)) this.removeAttachment(idx);
      return;
    }
    if (msg.type === 'openPermPicker') { await this.openPermPicker(); return; }
    if (msg.type === 'openLanguagePicker') { await this.openLanguagePicker(); return; }
    if (msg.type === 'openModelPicker') { await this.openModelPicker(); return; }
    if (msg.type === 'toggleThinking') { this.toggleThinking(); return; }

    if (msg.type === 'send' && msg.text) {
      this.stopFlag = false;
      const trimmed = msg.text.trim();
      const lower = trimmed.toLowerCase();

      // Slash command routing — handled explicitly before chat/workflow dispatch
      if (lower === '/help' || lower === '/?') {
        this.post({ type: 'info', text: 'Modes:\n  Chat     — pure conversation, no tools.\n  Workflow — tools + agent loop.\n\nSlash commands:\n  /translate                — translate attached files to output language\n  /diffreview [requirements]— analyze git diff vs requirements\n  /fixbug [guidance]        — review/fix bugs (whole project or attachments)\n  /pts [context]            — generate unit tests from diff + attachments\n  /its [context]            — generate UAT tests from diff + attachments\n  /do <goal>                — run full plan→execute→test→fix orchestrator\n  /help                     — this list' });
        return;
      }
      if (lower.startsWith('/do ')) {
        if (this.mode !== 'workflow') { this.post({ type: 'info', text: '/do requires Workflow mode.' }); return; }
        await this.runDo(trimmed.slice(4).trim());
        return;
      }
      if (lower === '/translate' || lower.startsWith('/translate ')) {
        await this.cmdTranslate(trimmed.slice(10).trim());
        return;
      }
      if (lower === '/diffreview' || lower.startsWith('/diffreview ')) {
        if (this.mode !== 'workflow') { this.post({ type: 'info', text: '/diffreview requires Workflow mode.' }); return; }
        await this.cmdDiffReview(trimmed.slice(11).trim());
        return;
      }
      if (lower === '/fixbug' || lower.startsWith('/fixbug ')) {
        if (this.mode !== 'workflow') { this.post({ type: 'info', text: '/fixbug requires Workflow mode.' }); return; }
        await this.cmdFixBug(trimmed.slice(7).trim());
        return;
      }
      if (lower === '/pts' || lower.startsWith('/pts ')) {
        if (this.mode !== 'workflow') { this.post({ type: 'info', text: '/pts requires Workflow mode.' }); return; }
        await this.cmdPts(trimmed.slice(4).trim());
        return;
      }
      if (lower === '/its' || lower.startsWith('/its ')) {
        if (this.mode !== 'workflow') { this.post({ type: 'info', text: '/its requires Workflow mode.' }); return; }
        await this.cmdIts(trimmed.slice(4).trim());
        return;
      }

      if (this.mode === 'chat') {
        await this.runChat(trimmed);
      } else {
        await this.runTurn(trimmed);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Attachments (A6)
  // ───────────────────────────────────────────────────────────────────────

  private addActiveFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { this.post({ type: 'error', text: 'No active editor. Open a file first.' }); return; }
    const p = editor.document.uri.fsPath;
    if (this.attachments.some((a) => a.path === p && a.type === 'file')) {
      this.post({ type: 'info', text: `Already attached: ${path.basename(p)}` });
      return;
    }
    this.attachments.push({ path: p, type: 'file' });
    this.broadcastAttachments();
    this.post({ type: 'info', text: `Attached file: ${path.basename(p)}` });
  }

  private addActiveFolder() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { this.post({ type: 'error', text: 'No active editor. Open a file inside the target folder first.' }); return; }
    const folder = path.dirname(editor.document.uri.fsPath);
    if (this.attachments.some((a) => a.path === folder && a.type === 'folder')) {
      this.post({ type: 'info', text: `Already attached: ${path.basename(folder)}` });
      return;
    }
    this.attachments.push({ path: folder, type: 'folder' });
    this.broadcastAttachments();
    this.post({ type: 'info', text: `Attached folder: ${path.basename(folder)}/` });
  }

  private removeAttachment(idx: number) {
    if (idx < 0 || idx >= this.attachments.length) return;
    const removed = this.attachments.splice(idx, 1)[0];
    this.broadcastAttachments();
    if (removed) this.post({ type: 'info', text: `Removed: ${path.basename(removed.path)}` });
  }

  private clearAttachments() {
    if (this.attachments.length === 0) return;
    this.attachments = [];
    this.broadcastAttachments();
  }

  private broadcastAttachments() {
    this.panel.webview.postMessage({ type: 'attachments', items: this.attachments });
  }

  private toRel(p: string): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return p;
    const rel = path.relative(ws, p).replace(/\\/g, '/');
    return rel || path.basename(p);
  }

  private readAttachmentsAsBlock(maxBytes: number = 16000): string {
    if (this.attachments.length === 0) return '';
    const parts: string[] = [];
    let total = 0;
    for (const a of this.attachments) {
      if (total >= maxBytes) { parts.push('[...more attachments truncated]'); break; }
      const rel = this.toRel(a.path);
      if (a.type === 'file') {
        try {
          let content = fs.readFileSync(a.path, 'utf8');
          const budget = maxBytes - total - rel.length - 20;
          if (content.length > budget) content = content.slice(0, Math.max(200, budget)) + '\n[...truncated]';
          parts.push(`## ${rel}\n\`\`\`\n${content}\n\`\`\``);
          total += content.length + rel.length + 20;
        } catch (e) {
          parts.push(`## ${rel}\n[error reading: ${e instanceof Error ? e.message : 'unknown'}]`);
        }
      } else {
        try {
          const entries = fs.readdirSync(a.path, { withFileTypes: true })
            .filter((d: fs.Dirent) => !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'dist')
            .slice(0, 60)
            .map((d: fs.Dirent) => d.isDirectory() ? d.name + '/' : d.name)
            .join('\n');
          parts.push(`## ${rel}/ (folder listing)\n${entries || '(empty)'}`);
          total += entries.length + rel.length + 30;
        } catch {
          parts.push(`## ${rel}\n[error listing folder]`);
        }
      }
    }
    return '<attachments>\n' + parts.join('\n\n') + '\n</attachments>';
  }

  // ───────────────────────────────────────────────────────────────────────
  // Pickers via VSCode QuickPick (A5/A7/A9/A10)
  // ───────────────────────────────────────────────────────────────────────

  private async openPermPicker() {
    const items = (Object.keys(PERM_LABELS) as PermMode[]).map((v) => ({
      label: PERM_LABELS[v],
      detail: this.permDetail(v),
      value: v,
      picked: v === this.permMode
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Current: ${PERM_LABELS[this.permMode]}` });
    if (!pick) return;
    this.permMode = pick.value;
    this.panel.webview.postMessage({ type: 'permModeChanged', label: PERM_LABELS[this.permMode] });
    this.post({ type: 'info', text: `Permission mode: ${PERM_LABELS[this.permMode]}` });
  }

  private effectiveAutoApprove(): Set<string> {
    const cfg = vscode.workspace.getConfiguration('vdsx');
    const baseArr = cfg.get<string[]>('autoApprove', ['read_file', 'grep', 'glob']);
    const base = new Set(baseArr);
    if (this.permMode === 'bypass') return new Set(['read_file', 'write_file', 'edit_file', 'grep', 'glob', 'bash']);
    if (this.permMode === 'auto') return new Set(['read_file', 'write_file', 'edit_file', 'grep', 'glob']);
    if (this.permMode === 'auto-edit') { base.add('edit_file'); base.add('write_file'); return base; }
    // 'ask' and 'plan' both use base (plan mode enforces deny at askApproval level)
    return base;
  }

  private permDetail(m: PermMode): string {
    return {
      'ask': 'Approval modal for every risky tool (safest).',
      'auto-edit': 'Auto-approve edit_file & write_file; ask bash.',
      'plan': 'Read-only — deny write/edit/bash.',
      'auto': 'Auto-approve all non-bash; ask bash.',
      'bypass': 'Auto-approve EVERY tool incl. bash (DANGEROUS).'
    }[m];
  }

  private async openLanguagePicker() {
    const items: Array<{ label: string; value: OutputLang; detail?: string }> = [
      { label: 'English', value: 'en', detail: 'No translation' },
      { label: 'Tiếng Việt', value: 'vi', detail: 'Translate summaries to Vietnamese' },
      { label: '日本語', value: 'ja', detail: 'Translate summaries to Japanese' }
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Current: ${LANG_NAMES[this.outputLang]}` });
    if (!pick) return;
    this.outputLang = pick.value;
    this.panel.webview.postMessage({ type: 'languageChanged', value: this.outputLang });
    this.post({ type: 'info', text: `Output language: ${pick.label}` });
  }

  private async openModelPicker() {
    const cfg = vscode.workspace.getConfiguration('vdsx');
    const extras = cfg.get<ModelEntry[]>('ollama.models', []) || [];
    const defaultModel = cfg.get<string>('ollama.model', 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf');
    const defaultHost = cfg.get<string>('ollama.host', 'http://192.168.1.220:11434');
    const defaultCtx = cfg.get<number>('ollama.numCtx', 49152);

    const fmtDetail = (m: { model: string; host?: string; numCtx?: number; temperature?: number }) => {
      const parts: string[] = [m.model];
      if (m.host) parts.push(`@ ${m.host}`);
      if (m.numCtx) parts.push(`ctx=${m.numCtx}`);
      if (typeof m.temperature === 'number') parts.push(`T=${m.temperature}`);
      return parts.join(' · ');
    };

    const items: Array<{ label: string; description?: string; detail?: string; entry: ModelEntry | null }> = [
      {
        label: 'Default (workspace settings)',
        description: this.modelOverride ? '' : '✓ active',
        detail: fmtDetail({ model: defaultModel, host: defaultHost, numCtx: defaultCtx }),
        entry: null
      }
    ];
    for (const m of extras) {
      items.push({
        label: m.label,
        description: this.modelOverride?.label === m.label ? '✓ active' : '',
        detail: fmtDetail(m),
        entry: m
      });
    }
    if (items.length === 1) {
      this.post({ type: 'info', text: 'No additional models in vdsx.ollama.models. Add entries via settings.json.' });
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Pick a model — each preset can override host, apiKey, numCtx, temperature, maxOutput',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!pick) return;
    this.modelOverride = pick.entry;
    const label = pick.entry ? pick.label : '';
    this.panel.webview.postMessage({ type: 'modelChanged', label });
    this.post({ type: 'info', text: `Model: ${pick.label}${pick.detail ? ' — ' + pick.detail : ''}` });
  }

  private toggleThinking() {
    this.thinking = !this.thinking;
    this.panel.webview.postMessage({ type: 'thinkingChanged', value: this.thinking });
    this.post({ type: 'info', text: `Thinking: ${this.thinking ? 'on' : 'off'}` });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Output language — post-response translation (A7)
  // ───────────────────────────────────────────────────────────────────────

  private async translateSummaryStreamed(text: string): Promise<string> {
    if (this.outputLang === 'en' || !text.trim()) return text;
    const cfg = this.buildLlmConfig();
    if (!cfg) return text;
    this.post({ type: 'info', text: `Translating to ${LANG_NAMES[this.outputLang]}...` });
    const prompt = `Translate the following summary to ${LANG_NAMES[this.outputLang]}. Keep code blocks, file paths, command names, and technical terms UNCHANGED. Return ONLY the translation, no preamble, no explanation.\n\n---\n${text}`;
    try {
      this.streamStart(`translate → ${this.outputLang}`);
      const resp = await chat({ ...cfg, temperature: 0.1 }, [{ role: 'user', content: prompt }], [], {
        onChunk: (d) => this.streamChunk(d),
        shouldAbort: () => this.stopFlag
      });
      this.streamEnd();
      return resp.content || text;
    } catch (e) {
      this.streamEnd();
      this.post({ type: 'error', text: `Translation failed: ${e instanceof Error ? e.message : 'unknown'}` });
      return text;
    }
  }

  private async maybeTranslateLastAssistant(): Promise<void> {
    if (this.outputLang === 'en') return;
    const last = [...this.history].reverse().find((m) => m.role === 'assistant' && m.content && m.content.trim());
    if (!last?.content) return;
    const translated = await this.translateSummaryStreamed(last.content);
    if (translated && translated !== last.content) {
      this.logs[this.mode].push({ type: 'assistant', text: `[${this.outputLang}] ${translated}` });
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Slash command implementations (A8)
  // ───────────────────────────────────────────────────────────────────────

  private async cmdTranslate(_extraText: string): Promise<void> {
    if (this.attachments.length === 0) {
      this.post({ type: 'error', text: 'No files attached. Use + → Add file to attach first.' });
      return;
    }
    const llmCfg = this.buildLlmConfig();
    if (!llmCfg) return;
    const probeErr = await probe(llmCfg);
    if (probeErr) { this.post({ type: 'error', text: probeErr }); return; }

    const targetLang = this.outputLang === 'en' ? 'Vietnamese' : LANG_NAMES[this.outputLang];
    if (this.outputLang === 'en') {
      this.post({ type: 'info', text: 'Output language is English — translating to Vietnamese by default. Change via Output language.' });
    }

    this.panel.webview.postMessage({ type: 'running', value: true });
    this.post({ type: 'user', text: `/translate (${this.attachments.length} file${this.attachments.length === 1 ? '' : 's'})` });

    try {
      for (const a of this.attachments) {
        if (this.stopFlag) break;
        if (a.type !== 'file') { this.post({ type: 'info', text: `Skipping folder: ${this.toRel(a.path)}` }); continue; }
        let content: string;
        try { content = fs.readFileSync(a.path, 'utf8'); }
        catch (e) { this.post({ type: 'error', text: `Read failed ${this.toRel(a.path)}: ${e instanceof Error ? e.message : 'unknown'}` }); continue; }
        this.post({ type: 'info', text: `Translating ${this.toRel(a.path)} → ${targetLang}...` });
        const prompt = `Translate the content below to ${targetLang}. Preserve code fences, identifiers, file paths, and technical terms unchanged. Return ONLY the translated content.\n\n${content}`;
        this.streamStart(`${this.toRel(a.path)} → ${targetLang}`);
        const resp = await chat({ ...llmCfg, temperature: 0.2 }, [{ role: 'user', content: prompt }], [], {
          onChunk: (d) => this.streamChunk(d),
          shouldAbort: () => this.stopFlag
        });
        this.streamEnd();
        this.logs[this.mode].push({ type: 'assistant', text: `### ${this.toRel(a.path)} (${targetLang})\n\n${resp.content || '(empty)'}` });
      }
      this.clearAttachments();
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.panel.webview.postMessage({ type: 'running', value: false });
    }
  }

  private async cmdDiffReview(extraText: string): Promise<void> {
    const llmCfg = this.buildLlmConfig();
    if (!llmCfg) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { this.post({ type: 'error', text: 'Open a workspace folder first.' }); return; }

    this.panel.webview.postMessage({ type: 'running', value: true });
    this.post({ type: 'user', text: `/diffreview${extraText ? ' ' + extraText : ''}` });

    try {
      if (!(await isGitRepo(ws))) { this.post({ type: 'error', text: 'Not a git repository.' }); return; }
      this.post({ type: 'info', text: 'Running git diff...' });
      const diff = await runGitDiff(ws);
      if (!diff.trim()) { this.post({ type: 'info', text: 'No changes in working tree.' }); return; }
      const diffPath = await saveDiffToVdsx(ws, diff, 'review');
      this.post({ type: 'info', text: `Diff saved: ${diffPath}` });

      const attachContent = this.readAttachmentsAsBlock();
      const hasRequirement = Boolean(extraText.trim() || attachContent);
      let prompt: string;
      if (!hasRequirement) {
        prompt = `Summarize the following git diff. List: files changed, high-level intent per change, risks.\n\n\`\`\`diff\n${diff.slice(0, 60000)}\n\`\`\``;
      } else {
        const req = [extraText.trim(), attachContent].filter(Boolean).join('\n\n');
        prompt = `Given the REQUIREMENT below, analyze whether the DIFF implements it. List: (1) what's covered, (2) gaps/missing, (3) potential issues.\n\nREQUIREMENT:\n${req}\n\nDIFF:\n\`\`\`diff\n${diff.slice(0, 60000)}\n\`\`\``;
      }
      this.streamStart('diff review');
      const resp = await chat({ ...llmCfg, temperature: 0.2 }, [{ role: 'user', content: prompt }], [], {
        onChunk: (d) => this.streamChunk(d),
        shouldAbort: () => this.stopFlag
      });
      this.streamEnd();
      this.history.push({ role: 'user', content: prompt });
      this.history.push(resp);
      if (resp.content) this.logs[this.mode].push({ type: 'assistant', text: resp.content });
      this.clearAttachments();
      await this.maybeTranslateLastAssistant();
    } catch (e) {
      this.streamEnd();
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.panel.webview.postMessage({ type: 'running', value: false });
    }
  }

  private async cmdFixBug(extraText: string): Promise<void> {
    const llmCfg = this.buildLlmConfig();
    if (!llmCfg) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { this.post({ type: 'error', text: 'Open a workspace folder first.' }); return; }

    const hasGuidance = Boolean(extraText.trim() || this.attachments.length > 0);

    this.panel.webview.postMessage({ type: 'running', value: true });
    this.post({ type: 'user', text: `/fixbug${extraText ? ' ' + extraText : ''}${this.attachments.length ? ` (+${this.attachments.length} attachments)` : ''}` });

    try {
      if (!hasGuidance) {
        // Sequential project-wide review, cap 20 files
        this.post({ type: 'info', text: 'No guidance — scanning project root for review (cap 20 files)...' });
        const files = this.collectProjectFiles(ws, 20);
        if (files.length === 0) { this.post({ type: 'info', text: 'No reviewable files found.' }); return; }
        for (const f of files) {
          if (this.stopFlag) break;
          let content: string;
          try { content = fs.readFileSync(f, 'utf8').slice(0, 6000); }
          catch { continue; }
          const rel = this.toRel(f);
          this.post({ type: 'info', text: `Reviewing ${rel}...` });
          const prompt = `Review this file for bugs, security issues, and code smells. Be specific: cite line numbers or snippets. If clean, say so.\n\n## ${rel}\n\`\`\`\n${content}\n\`\`\``;
          this.streamStart(`review ${rel}`);
          const resp = await chat({ ...llmCfg, temperature: 0.2 }, [{ role: 'user', content: prompt }], [], {
            onChunk: (d) => this.streamChunk(d),
            shouldAbort: () => this.stopFlag
          });
          this.streamEnd();
          if (resp.content) this.logs[this.mode].push({ type: 'assistant', text: `### ${rel}\n\n${resp.content}` });
        }
        this.post({ type: 'info', text: 'Review complete.' });
      } else {
        // Targeted review with attachments + input text → suggest fixes (no auto-edit)
        const attachContent = this.readAttachmentsAsBlock();
        const prompt = `Review the attached code for bugs. PROPOSE fixes as unified diffs or code snippets. Do NOT describe, just show the fix. User will apply manually.\n\nGUIDANCE:\n${extraText || '(review attachments holistically)'}\n\n${attachContent}`;
        this.post({ type: 'info', text: 'Analyzing...' });
        this.streamStart('fixbug');
        const resp = await chat({ ...llmCfg, temperature: 0.2 }, [{ role: 'user', content: prompt }], [], {
          onChunk: (d) => this.streamChunk(d),
          shouldAbort: () => this.stopFlag
        });
        this.streamEnd();
        this.history.push({ role: 'user', content: prompt });
        this.history.push(resp);
        if (resp.content) this.logs[this.mode].push({ type: 'assistant', text: resp.content });
        this.clearAttachments();
        await this.maybeTranslateLastAssistant();
      }
    } catch (e) {
      this.streamEnd();
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.panel.webview.postMessage({ type: 'running', value: false });
    }
  }

  private collectProjectFiles(root: string, cap: number): string[] {
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.vdsx', '.vscode-test']);
    const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.json', '.yaml', '.yml']);
    const out: string[] = [];
    const walk = (dir: string) => {
      if (out.length >= cap) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= cap) return;
        if (IGNORE.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && exts.has(path.extname(e.name))) out.push(full);
      }
    };
    walk(root);
    return out.slice(0, cap);
  }

  private async cmdPts(extraText: string): Promise<void> { await this.cmdTestGen('pts', extraText); }
  private async cmdIts(extraText: string): Promise<void> { await this.cmdTestGen('its', extraText); }

  private async cmdTestGen(kind: 'pts' | 'its', extraText: string): Promise<void> {
    const llmCfg = this.buildLlmConfig();
    if (!llmCfg) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { this.post({ type: 'error', text: 'Open a workspace folder first.' }); return; }

    this.panel.webview.postMessage({ type: 'running', value: true });
    this.post({ type: 'user', text: `/${kind}${extraText ? ' ' + extraText : ''}${this.attachments.length ? ` (+${this.attachments.length} attachments)` : ''}` });

    try {
      const diff = (await isGitRepo(ws)) ? await runGitDiff(ws) : '';
      const attachContent = this.readAttachmentsAsBlock();
      const kindLabel = kind === 'pts' ? 'unit tests (happy path + edge cases + error paths)' : 'UAT / end-to-end test scenarios (Gherkin Given/When/Then or numbered manual test steps)';
      const ext = kind === 'pts' ? 'test.md' : 'uat.md';

      const planPrompt = `You will generate ${kindLabel}. First propose 1-5 test files with path suggestions (inside .vdsx/tests/) and a one-line purpose each. Output ONLY JSON: {"tests":[{"filename":"...","purpose":"..."}]}.\n\nDIFF:\n\`\`\`diff\n${diff.slice(0, 30000) || '(no diff)'}\n\`\`\`\n\n${attachContent}\n\nREQUIREMENTS/CONTEXT:\n${extraText || '(none)'}`;
      this.post({ type: 'info', text: 'Planning test files...' });
      const planResp = await chat({ ...llmCfg, temperature: 0.1 }, [{ role: 'user', content: planPrompt }], []);
      type PlannedTest = { filename: string; purpose: string };
      let plan: { tests: PlannedTest[] };
      try {
        const txt = (planResp.content || '').trim();
        const match = /\{[\s\S]*\}/.exec(txt);
        plan = match ? JSON.parse(match[0]) : { tests: [] };
      } catch {
        plan = { tests: [] };
      }
      if (!plan.tests || plan.tests.length === 0) {
        plan = { tests: [{ filename: `${kind}-${timestamp()}.${ext}`, purpose: 'Generated tests' }] };
      }

      ensureVdsxDir(ws, 'tests');
      for (const t of plan.tests) {
        if (this.stopFlag) break;
        const safeName = t.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const rel = `.vdsx/tests/${safeName}`;
        const abs = path.join(ws, rel);
        const exists = fs.existsSync(abs);
        if (exists) this.post({ type: 'info', text: `⚠ Overwriting: ${rel}` });
        this.post({ type: 'info', text: `Generating ${rel} — ${t.purpose}...` });
        const genPrompt = kind === 'pts'
          ? `Write unit tests for: ${t.purpose}.\nCover happy path, edge cases, error paths. Include setup/teardown if needed.\nDetect test framework from DIFF/attachments or default to Jest.\nOutput ONLY code — no preamble, no explanation.\n\nDIFF:\n\`\`\`diff\n${diff.slice(0, 30000) || '(no diff)'}\n\`\`\`\n\n${attachContent}\n\nCONTEXT:\n${extraText || '(none)'}`
          : `Write UAT/e2e test scenarios for: ${t.purpose}.\nFormat: Gherkin (Given/When/Then) OR numbered manual test steps.\nCover happy path, error states, edge UI states, accessibility concerns.\nOutput ONLY scenarios.\n\nDIFF:\n\`\`\`diff\n${diff.slice(0, 30000) || '(no diff)'}\n\`\`\`\n\n${attachContent}\n\nCONTEXT:\n${extraText || '(none)'}`;
        this.streamStart(`${kind} → ${rel}`);
        const gen = await chat({ ...llmCfg, temperature: 0.2 }, [{ role: 'user', content: genPrompt }], [], {
          onChunk: (d) => this.streamChunk(d),
          shouldAbort: () => this.stopFlag
        });
        this.streamEnd();
        const body = (gen.content || '').replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
        fs.writeFileSync(abs, body, 'utf8');
        this.post({ type: 'info', text: `Saved: ${rel} (${body.length} bytes)` });
      }
      this.clearAttachments();
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.panel.webview.postMessage({ type: 'running', value: false });
    }
  }

  private buildLlmConfig(): LlmConfig | null {
    const cfg = vscode.workspace.getConfiguration('vdsx');
    const baseApiKey = cfg.get<string>('ollama.apiKey', '');
    const baseHost = cfg.get<string>('ollama.host', 'http://192.168.1.220:11434');
    const baseModel = cfg.get<string>('ollama.model', 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf');
    const baseCtx = cfg.get<number>('ollama.numCtx', 49152);
    const baseTemp = cfg.get<number>('ollama.temperature', 0.2);
    const baseOut = cfg.get<number>('ollama.maxOutput', 12000);

    const override = this.modelOverride;
    const host = override?.host ?? baseHost;
    const model = override?.model ?? baseModel;
    const apiKey = override?.apiKey ?? baseApiKey;
    const numCtx = override?.numCtx ?? baseCtx;
    const temperature = override?.temperature ?? baseTemp;
    const maxOutput = override?.maxOutput ?? baseOut;

    if (!apiKey) {
      this.post({ type: 'error', text: 'vdsx.ollama.apiKey is not set. Add it to VSCode settings, or pick a model with apiKey via Switch model menu.' });
      return null;
    }
    return { host, model, apiKey, numCtx, temperature, maxOutput };
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
    this.panel.webview.postMessage({ type: 'running', value: true });

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
          },
          onStreamStart: (phase) => this.streamStart(phase),
          onStreamChunk: (_phase, delta) => this.streamChunk(delta),
          onStreamEnd: (_phase, _text) => this.streamEnd(),
          shouldStop: () => this.stopFlag
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
          onReport: async (md) => {
            this.post({ type: 'assistant', text: md });
            if (this.outputLang !== 'en') {
              const translated = await this.translateSummaryStreamed(md);
              if (translated && translated !== md) {
                this.post({ type: 'assistant', text: `[${this.outputLang}] ${translated}` });
              }
            }
          },
          shouldStop: () => this.stopFlag
        }
      );
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.panel.webview.postMessage({ type: 'running', value: false });
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
    const attachBlock = this.readAttachmentsAsBlock();
    const userMsgContent = attachBlock ? `${attachBlock}\n\n${userText}` : userText;
    this.history.push({ role: 'user', content: userMsgContent });
    this.post({ type: 'user', text: userText + (this.attachments.length ? ` (+${this.attachments.length} attachment${this.attachments.length === 1 ? '' : 's'})` : '') });
    this.clearAttachments();

    // Phase-0 instrumentation
    const preBudget = breakdownMessages(this.history);
    this.post({ type: 'info', text: 'pre-call ' + formatBreakdown(preBudget, 0, llmCfg.numCtx) });

    this.panel.webview.postMessage({ type: 'running', value: true });
    try {
      if (this.stopFlag) return;
      this.streamStart();
      const reply = await chat(llmCfg, this.history, [], {
        onChunk: (delta) => this.streamChunk(delta),
        shouldAbort: () => this.stopFlag
      });
      this.streamEnd();
      this.history.push(reply);
      if (reply.content) this.logs[this.mode].push({ type: 'assistant', text: reply.content });
      await this.maybeTranslateLastAssistant();
    } catch (e) {
      this.streamEnd();
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.panel.webview.postMessage({ type: 'running', value: false });
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
    const autoApprove = this.effectiveAutoApprove();

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
    if (this.thinking) systemParts.push('Think step-by-step inside <thinking>...</thinking> blocks before tool calls or final answer. Keep thinking blocks internal — focus final answer outside thinking.');
    if (this.outputLang !== 'en') systemParts.push(`Work internally in English. Tool calls, code, file paths MUST stay in English. User-facing summaries will be translated to ${LANG_NAMES[this.outputLang]} separately.`);
    if (this.permMode === 'plan') systemParts.push('PLAN MODE: you MUST NOT call write_file, edit_file, or bash. Only read_file, grep, glob are allowed. Produce a written plan instead.');
    const system = systemParts.join('\n\n');

    if (this.history.length === 0) {
      this.history.push({ role: 'system', content: system });
    }
    const attachBlock = this.readAttachmentsAsBlock();
    const userMsgContent = attachBlock ? `${attachBlock}\n\n${userText}` : userText;
    this.history.push({ role: 'user', content: userMsgContent });
    this.post({ type: 'user', text: userText + (this.attachments.length ? ` (+${this.attachments.length} attachment${this.attachments.length === 1 ? '' : 's'})` : '') });
    this.clearAttachments();

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

    this.panel.webview.postMessage({ type: 'running', value: true });
    try {
      await runAgent(this.history, {
        cfg: llmCfg,
        allowedTools,
        maxIterations: maxIter,
        autoApprove,
        ctx,
        onMessage: (m) => {
          // Stream already delivered content via chunks; we only need to track final assistant text in log
          if (m.role === 'assistant' && m.content) this.logs[this.mode].push({ type: 'assistant', text: m.content });
        },
        onToolCall: (n, a) => this.post({ type: 'toolCall', name: n, args: a }),
        onToolResult: (n, r) => {
          const toks = estimateTokens(r);
          this.post({ type: 'info', text: `tool ${n} → ${r.length} bytes (~${toks} tok)` });
          this.post({ type: 'toolResult', name: n, result: r.length > 4000 ? r.slice(0, 4000) + '\n[...truncated for UI]' : r });
        },
        shouldStop: () => this.stopFlag,
        onStreamStart: () => this.streamStart(),
        onStreamChunk: (delta) => this.streamChunk(delta),
        onStreamEnd: () => this.streamEnd()
      });
      await this.maybeTranslateLastAssistant();
    } catch (e) {
      this.streamEnd();
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.panel.webview.postMessage({ type: 'running', value: false });
    }

    // Phase-0 instrumentation: log final history size after tool results + assistant responses
    const postBudget = breakdownMessages(this.history);
    const delta = postBudget.total - preBudget.total;
    this.post({ type: 'info', text: `post-call ${formatBreakdown(postBudget, schemaTokens, llmCfg.numCtx)} (Δ +${delta} tok this turn)` });
  }

  private async askApproval(tool: string, args: Record<string, unknown>): Promise<boolean> {
    // Plan mode: hard deny write/edit/bash regardless of approval
    if (this.permMode === 'plan' && (tool === 'write_file' || tool === 'edit_file' || tool === 'bash')) {
      this.post({ type: 'info', text: `[plan mode] denied ${tool} — switch permission mode to apply changes.` });
      return false;
    }
    // Bypass: allow all without prompt
    if (this.permMode === 'bypass') return true;
    // Auto: non-bash auto-approved (already in autoApprove set); bash falls through to prompt
    // Ask / auto-edit: prompt
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
  .assistant.streaming .body { white-space: pre-wrap; }
  .assistant.thinking .body { color: var(--vscode-descriptionForeground); font-style: italic; }
  .cursor-blink::after {
    content: '▍';
    margin-left: 1px;
    animation: blink 1s infinite;
    opacity: 0.6;
  }
  @keyframes blink { 0%, 50% { opacity: 0.6; } 51%, 100% { opacity: 0; } }
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
  #attachmentBar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px 0;
  }
  #attachmentBar:empty { padding: 0; }
  .attach-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 6px 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family);
  }
  .attach-chip .close {
    cursor: pointer;
    padding: 0 2px;
    opacity: 0.7;
  }
  .attach-chip .close:hover { opacity: 1; }
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
    min-width: 32px;
  }
  #sendBtn:hover { background: var(--vscode-button-hoverBackground); }
  #sendBtn:disabled { opacity: 0.4; cursor: not-allowed; }
  #sendBtn.stop {
    background: var(--vscode-errorForeground, #e57373);
    color: var(--vscode-editor-background);
  }
  #sendBtn.stop:hover { opacity: 0.85; }

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
      <div id="attachmentBar"></div>
      <textarea id="input" placeholder="Ask or instruct... (Ctrl+Enter to send)"></textarea>
      <div id="composerFooter">
        <button class="footer-btn" id="plusBtn" title="Add context">+</button>
        <button class="footer-btn" id="slashBtn" title="Slash commands & modes">/</button>
        <span id="agentChip" style="display:none"></span>
        <div class="footer-spacer"></div>
        <span id="modeChip" title="Click to switch">Workflow</span>
        <span id="modePermission" title="Permission mode">Ask before edits</span>
        <button id="sendBtn" class="send" title="Send (Ctrl+Enter)">↑</button>
      </div>
    </div>
  </div>

  <!-- Actions menu (⋯ in title bar) -->
  <div class="popup" id="actionsMenu">
    <div class="section">Context</div>
    <div class="item" data-action="clear">Clear conversation</div>
    <div class="item" data-action="reload">Reload ECC</div>
  </div>

  <!-- + menu (composer) -->
  <div class="popup" id="plusMenu">
    <div class="section">Input</div>
    <div class="item" data-action="addfile">Add file</div>
    <div class="item" data-action="addfolder">Add folder</div>
  </div>

  <!-- / menu (composer) -->
  <div class="popup" id="slashMenu">
    <div class="section">Agent Modes</div>
    <div class="item" data-mode="chat">Chat only <span class="desc">pure conversation</span></div>
    <div class="item" data-mode="workflow">Workflow <span class="desc">tools + agent loop</span></div>
    <div class="divider"></div>
    <div class="section">Agents</div>
    <div id="agentList"></div>
    <div class="divider"></div>
    <div class="section">Settings</div>
    <div class="item" data-action="switch-model">Switch model <span class="desc" id="modelDesc"></span></div>
    <div class="item" data-action="toggle-thinking">Thinking <span class="desc" id="thinkingDesc">off</span></div>
    <div class="item" data-action="switch-language">Output language <span class="desc" id="langDesc">en</span></div>
    <div class="divider"></div>
    <div class="section">Slash Commands</div>
    <div class="item" data-insert="/translate">/translate <span class="desc">translate attached files</span></div>
    <div class="item" data-insert="/diffreview">/diffreview <span class="desc">analyze git diff</span></div>
    <div class="item" data-insert="/fixbug">/fixbug <span class="desc">review &amp; fix bugs</span></div>
    <div class="item" data-insert="/pts ">/pts <span class="desc">generate unit tests</span></div>
    <div class="item" data-insert="/its ">/its <span class="desc">generate UAT tests</span></div>
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
  let running = false;
  let streamingBlock = null;  // DOM node currently receiving stream chunks
  let streamingBodyEl = null; // body sub-element inside streamingBlock
  let streamingFirstChunk = true;
  const sendBtn = document.getElementById('sendBtn');

  function setRunning(r) {
    running = r;
    if (r) { sendBtn.classList.add('stop'); sendBtn.textContent = '◼'; sendBtn.title = 'Stop generation'; }
    else { sendBtn.classList.remove('stop'); sendBtn.textContent = '↑'; sendBtn.title = 'Send (Ctrl+Enter)'; }
  }

  function startStream(phase) {
    const d = document.createElement('div');
    d.className = 'msg assistant streaming thinking';
    const h = document.createElement('div');
    h.className = 'label';
    h.textContent = phase ? 'Assistant · ' + phase : 'Assistant';
    d.appendChild(h);
    const b = document.createElement('div');
    b.className = 'body cursor-blink';
    b.textContent = 'thinking...';
    d.appendChild(b);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    streamingBlock = d;
    streamingBodyEl = b;
    streamingFirstChunk = true;
  }

  function appendStreamChunk(delta) {
    if (!streamingBlock || !streamingBodyEl) return;
    if (streamingFirstChunk) {
      streamingBodyEl.textContent = '';
      streamingBlock.classList.remove('thinking');
      streamingFirstChunk = false;
    }
    streamingBodyEl.textContent += delta;
    log.scrollTop = log.scrollHeight;
  }

  function endStream() {
    if (!streamingBlock) return;
    streamingBlock.classList.remove('streaming');
    if (streamingBodyEl) streamingBodyEl.classList.remove('cursor-blink');
    // If nothing streamed (pure tool call with no text), drop the empty thinking block
    if (streamingFirstChunk) {
      streamingBlock.remove();
    }
    streamingBlock = null;
    streamingBodyEl = null;
    streamingFirstChunk = true;
  }

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

  function renderAttachments(items) {
    const bar = document.getElementById('attachmentBar');
    if (!bar) return;
    bar.innerHTML = '';
    items.forEach((it, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      const label = document.createElement('span');
      const basename = (it.path || '').split(/[/\\\\]/).pop();
      label.textContent = (it.type === 'folder' ? '📁 ' : '') + (basename || it.path);
      label.title = it.path;
      chip.appendChild(label);
      const x = document.createElement('span');
      x.className = 'close';
      x.textContent = '×';
      x.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'removeAttachment', value: String(i) }); });
      chip.appendChild(x);
      bar.appendChild(chip);
    });
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
    else if (m.type === 'assistantStart') startStream(m.phase);
    else if (m.type === 'assistantChunk') appendStreamChunk(m.delta || '');
    else if (m.type === 'assistantEnd') endStream();
    else if (m.type === 'toolCall') { endStream(); add('tool', 'Tool call: ' + m.name, JSON.stringify(m.args, null, 2)); }
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
    else if (m.type === 'running') { setRunning(Boolean(m.value)); }
    else if (m.type === 'permModeChanged') {
      const el = document.getElementById('modePermission');
      if (el) el.textContent = m.label || 'Ask before edits';
    }
    else if (m.type === 'languageChanged') {
      const el = document.getElementById('langDesc');
      if (el) el.textContent = m.value || 'en';
    }
    else if (m.type === 'thinkingChanged') {
      const el = document.getElementById('thinkingDesc');
      if (el) el.textContent = m.value ? 'on' : 'off';
    }
    else if (m.type === 'modelChanged') {
      const el = document.getElementById('modelDesc');
      if (el) el.textContent = m.label || '';
    }
    else if (m.type === 'attachments') {
      renderAttachments(m.items || []);
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
  const modePermEl = document.getElementById('modePermission');
  if (modePermEl) modePermEl.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'openPermPicker' }); });
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
      else if (action === 'addfile') vscode.postMessage({ type: 'addActiveFile' });
      else if (action === 'addfolder') vscode.postMessage({ type: 'addActiveFolder' });
      else if (action === 'switch-model') vscode.postMessage({ type: 'openModelPicker' });
      else if (action === 'toggle-thinking') vscode.postMessage({ type: 'toggleThinking' });
      else if (action === 'switch-language') vscode.postMessage({ type: 'openLanguagePicker' });
      else if (action === 'switch-perm') vscode.postMessage({ type: 'openPermPicker' });
      else if (action === 'setperm') vscode.postMessage({ type: 'setPermMode', value: item.getAttribute('data-perm') });
      else if (action === 'setlang') vscode.postMessage({ type: 'setLanguage', value: item.getAttribute('data-lang') });
      else if (action === 'removeAttach') vscode.postMessage({ type: 'removeAttachment', value: item.getAttribute('data-idx') });
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

  sendBtn.addEventListener('click', () => {
    if (running) { vscode.postMessage({ type: 'stop' }); }
    else { send(); }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!running) send(); }
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
