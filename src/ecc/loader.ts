import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseFile, normalizeToolList, ParsedDoc } from './frontmatter';
import { mapClaudeTools } from './tool-mapping';

export interface AgentDef {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  source: string;
}

export interface CommandDef {
  name: string;
  description: string;
  body: string;
  source: string;
}

export interface RuleDoc {
  name: string;
  body: string;
  source: string;
}

export interface EccBundle {
  agents: AgentDef[];
  commands: CommandDef[];
  rules: RuleDoc[];
}

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function resolveRoot(workspaceRoot: string | undefined, raw: string): string {
  const expanded = expandHome(raw);
  if (path.isAbsolute(expanded)) return expanded;
  if (workspaceRoot) return path.join(workspaceRoot, expanded);
  return path.resolve(expanded);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function walkDir(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function agentFromDoc(doc: ParsedDoc): AgentDef | null {
  const name =
    (typeof doc.data.name === 'string' && doc.data.name) ||
    path.basename(doc.path, '.md');
  const rawTools = normalizeToolList(doc.data.tools);
  const tools = mapClaudeTools(rawTools);
  return {
    name,
    description: (doc.data.description as string) ?? '',
    systemPrompt: doc.body,
    tools,
    model: (doc.data.model as string) ?? undefined,
    source: doc.path
  };
}

function commandFromDoc(doc: ParsedDoc): CommandDef | null {
  const name =
    (typeof doc.data.name === 'string' && doc.data.name) ||
    path.basename(doc.path, '.md');
  return {
    name,
    description: (doc.data.description as string) ?? '',
    body: doc.body,
    source: doc.path
  };
}

export function loadEcc(roots: string[], workspaceRoot?: string): EccBundle {
  const agents: AgentDef[] = [];
  const commands: CommandDef[] = [];
  const rules: RuleDoc[] = [];

  for (const raw of roots) {
    const root = resolveRoot(workspaceRoot, raw);
    if (!fs.existsSync(root)) continue;

    // Agents
    for (const file of safeReaddir(path.join(root, 'agents'))) {
      const doc = parseFile(file);
      if (!doc) continue;
      const a = agentFromDoc(doc);
      if (a) agents.push(a);
    }

    // Commands
    for (const file of safeReaddir(path.join(root, 'commands'))) {
      const doc = parseFile(file);
      if (!doc) continue;
      const c = commandFromDoc(doc);
      if (c) commands.push(c);
    }

    // Rules — recursive (they live in rules/common, rules/python, etc.)
    for (const file of walkDir(path.join(root, 'rules'))) {
      const doc = parseFile(file);
      if (!doc) continue;
      rules.push({
        name: path.relative(path.join(root, 'rules'), file).replace(/\\/g, '/'),
        body: doc.body,
        source: file
      });
    }
  }

  return { agents, commands, rules };
}

export function buildSystemPrompt(agent: AgentDef, rules: RuleDoc[]): string {
  const parts = [agent.systemPrompt];
  if (rules.length > 0) {
    parts.push('\n---\n# Project rules (always apply)\n');
    for (const r of rules) parts.push(`\n## ${r.name}\n${r.body}`);
  }
  return parts.join('\n');
}
