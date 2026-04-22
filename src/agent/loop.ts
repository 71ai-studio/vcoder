import { ChatMessage, LlmConfig, chat } from './ollama';
import { ToolSchema, ToolContext } from './tools/types';
import { getHandler, getSchemas } from './tools/registry';

export interface LoopOptions {
  cfg: LlmConfig;
  allowedTools: string[] | null;
  maxIterations: number;
  autoApprove: Set<string>;
  ctx: ToolContext;
  onMessage: (m: ChatMessage) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string) => void;
  shouldStop: () => boolean;
}

export async function runAgent(
  messages: ChatMessage[],
  opts: LoopOptions
): Promise<ChatMessage[]> {
  const schemas: ToolSchema[] = getSchemas(opts.allowedTools);

  for (let i = 0; i < opts.maxIterations; i++) {
    if (opts.shouldStop()) break;

    const assistant = await chat(opts.cfg, messages, schemas);
    messages.push(assistant);
    opts.onMessage(assistant);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) return messages;

    for (const call of calls) {
      if (opts.shouldStop()) return messages;
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      opts.onToolCall(name, args);

      const handler = getHandler(name);
      let result: string;
      if (!handler) {
        result = `Error: unknown tool "${name}". Available: ${schemas.map((s) => s.function.name).join(', ')}`;
      } else {
        const wrappedCtx: ToolContext = {
          ...opts.ctx,
          approve: async (tn, a) => {
            if (opts.autoApprove.has(tn)) return true;
            return opts.ctx.approve(tn, a);
          }
        };
        try {
          result = await handler.run(args, wrappedCtx);
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      opts.onToolResult(name, result);
      const toolMsg: ChatMessage = {
        role: 'tool',
        content: result,
        tool_call_id: call.id
      };
      messages.push(toolMsg);
      opts.onMessage(toolMsg);
    }
  }

  return messages;
}
