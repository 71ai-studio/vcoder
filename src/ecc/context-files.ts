import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_MAX_BYTES = 8000;

/**
 * Load workspace-level context files (CLAUDE.md, AGENTS.md, etc.) and concatenate
 * their contents with filename headings. Caps total size to prevent blowing the
 * system prompt. Missing files are skipped silently.
 */
export function loadContextFiles(
  workspaceRoot: string,
  relPaths: string[],
  maxBytes: number = DEFAULT_MAX_BYTES
): string {
  const parts: string[] = [];
  let total = 0;
  for (const rel of relPaths) {
    const full = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue; // file not present — skip
    }
    const heading = `## ${rel}\n`;
    if (total + heading.length + content.length > maxBytes) {
      const budget = maxBytes - total - heading.length;
      if (budget > 200) {
        parts.push(heading + content.slice(0, budget) + '\n[truncated]');
      }
      break;
    }
    parts.push(heading + content);
    total += heading.length + content.length;
  }
  return parts.join('\n\n');
}

export function resolvePhaseAgents(
  bundle: { agents: Array<{ name: string; systemPrompt: string }> },
  mapping: Record<string, string>,
  maxBodyBytes = 4000
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [phase, agentName] of Object.entries(mapping)) {
    if (!agentName) continue;
    const agent = bundle.agents.find((a) => a.name === agentName);
    if (!agent) continue;
    const body = agent.systemPrompt.length > maxBodyBytes
      ? agent.systemPrompt.slice(0, maxBodyBytes) + '\n[…truncated]'
      : agent.systemPrompt;
    out[phase] = body;
  }
  return out;
}
