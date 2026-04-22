/**
 * Map ECC / Claude Code tool names (as written in agents/*.md frontmatter)
 * to VDS-X internal tool registry names.
 *
 * ECC uses PascalCase names native to Claude Code. Our registry uses snake_case.
 * Unknown / unsupported tools are dropped silently — subagent orchestration,
 * notebooks, web fetch, etc. are out of MVP scope.
 */
export const CLAUDE_TO_VDSX: Record<string, string | null> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Bash: 'bash',
  BashOutput: null,
  KillBash: null,
  Grep: 'grep',
  Glob: 'glob',
  WebFetch: null,
  WebSearch: null,
  Task: null,
  TodoWrite: null,
  NotebookEdit: null,
  SlashCommand: null,
  ExitPlanMode: null,
  EnterPlanMode: null
};

export function mapClaudeTools(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const key = n.trim();
    if (!key) continue;
    const mapped = Object.prototype.hasOwnProperty.call(CLAUDE_TO_VDSX, key)
      ? CLAUDE_TO_VDSX[key]
      : key.toLowerCase();
    if (mapped) out.add(mapped);
  }
  return [...out];
}
