/**
 * Rough token estimator for Qwen2.5-Coder (BPE). Markdown/English prose averages
 * ~3.7 chars/token; code/JSON is denser (~3.0-3.5). We use 3.7 as a conservative
 * middle — actual Qwen counts will be within ±15% for mixed content. This is for
 * UI budget display, not billing.
 */
import { ChatMessage } from './ollama';

export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.7);
}

export interface TokenBreakdown {
  system: number;
  user: number;
  assistant: number;
  tool: number;
  total: number;
  turnCount: number;
}

export function breakdownMessages(messages: ChatMessage[]): TokenBreakdown {
  let system = 0;
  let user = 0;
  let assistant = 0;
  let tool = 0;
  for (const m of messages) {
    const content = estimateTokens(m.content ?? '');
    const calls = m.tool_calls ? estimateTokens(JSON.stringify(m.tool_calls)) : 0;
    switch (m.role) {
      case 'system': system += content; break;
      case 'user': user += content; break;
      case 'assistant': assistant += content + calls; break;
      case 'tool': tool += content; break;
    }
  }
  return {
    system,
    user,
    assistant,
    tool,
    total: system + user + assistant + tool,
    turnCount: messages.length
  };
}

export function formatBreakdown(b: TokenBreakdown, schemaTokens: number, numCtx: number): string {
  const grandTotal = b.total + schemaTokens;
  const pct = numCtx > 0 ? Math.round((grandTotal / numCtx) * 100) : 0;
  return `[budget] sys=${b.system} user=${b.user} asst=${b.assistant} tool=${b.tool} schemas=${schemaTokens} total=${grandTotal} (${pct}% of ${numCtx}, ${b.turnCount} msgs)`;
}
