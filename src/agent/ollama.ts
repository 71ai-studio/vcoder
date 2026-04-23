/**
 * OpenAI-compatible LLM client (works with llama.cpp server, LM Studio, Ollama's OpenAI shim, etc.)
 *
 * Server at 192.168.1.220:11434 identifies as llama.cpp with OpenAI-compat /v1/chat/completions.
 * When the server is NOT started with structured tool parsing (--jinja), Qwen2.5-Coder emits
 * tool calls as inline XML inside message.content (e.g. <tool_call>{...}</tool_call> or <tools>{...}</tools>).
 * We extract both the structured `tool_calls` field AND the inline XML as a fallback.
 */

export interface LlmConfig {
  host: string;
  model: string;
  apiKey: string;
  temperature: number;
  numCtx: number; // sent only if server accepts it (llama.cpp OpenAI endpoint ignores)
  maxOutput?: number; // cap response tokens (llama.cpp n_predict); default 12000
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  tool_call_id?: string;
}

type JsonObject = Record<string, unknown>;

function parseArgs(x: unknown): JsonObject {
  if (!x) return {};
  if (typeof x === 'object') return x as JsonObject;
  if (typeof x === 'string') {
    try { return JSON.parse(x) as JsonObject; } catch { return {}; }
  }
  return {};
}

interface FoundCall { name: string; args: unknown; start: number; end: number; }

/** Scan text for bare JSON objects shaped like {"name": "...", "arguments": {...}}. */
function findBareJsonCalls(content: string): FoundCall[] {
  const results: FoundCall[] = [];
  const needle = /\{\s*"name"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = needle.exec(content)) !== null) {
    const start = m.index;
    // Walk forward finding the matching closing brace, respecting strings and escapes.
    let depth = 0;
    let end = -1;
    let inStr = false;
    let escape = false;
    for (let i = start; i < content.length; i++) {
      const c = content[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(content.slice(start, end)) as Record<string, unknown>;
      const name = parsed.name as string | undefined;
      const args = parsed.arguments ?? parsed.parameters;
      if (name && args !== undefined) {
        results.push({ name, args, start, end });
        needle.lastIndex = end;
      }
    } catch {
      // not a tool-call JSON — skip
    }
  }
  return results;
}

function normalizeAssistant(msg: Record<string, unknown>): ChatMessage {
  let content = (msg.content as string) ?? '';
  const tool_calls: ChatMessage['tool_calls'] = [];

  const native = msg.tool_calls;
  if (Array.isArray(native) && native.length > 0) {
    for (let i = 0; i < native.length; i++) {
      const tc = native[i] as Record<string, unknown>;
      const fn = tc.function as Record<string, unknown> | undefined;
      if (!fn) continue;
      tool_calls.push({
        id: (tc.id as string) ?? `call_${i}`,
        function: {
          name: (fn.name as string) ?? '',
          arguments: parseArgs(fn.arguments)
        }
      });
    }
  }

  // Inline XML fallback — any tag wrapping a {name, arguments} JSON object.
  // Qwen emits <tool_call>, <tools>, <function-calls>, <function_calls> etc. across turns.
  if (tool_calls.length === 0 && content) {
    const re = /<([a-zA-Z][\w-]*)>\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*<\/\1>/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(content)) !== null) {
      try {
        const obj = JSON.parse(m[2]) as Record<string, unknown>;
        const name = obj.name as string | undefined;
        if (name) {
          const rawArgs = (obj.arguments ?? obj.parameters) as unknown;
          tool_calls.push({
            id: `xml_${idx++}`,
            function: { name, arguments: parseArgs(rawArgs) }
          });
        }
      } catch {
        // malformed JSON in XML — skip, let the loop feed error back
      }
    }
    if (tool_calls.length > 0) {
      content = content.replace(re, '').trim();
    }
  }

  // Markdown fenced JSON fallback — local models often emit ```json / ```xml / ```tool_call / ```
  // fences with a {name, arguments} object when the chat template's <tool_call> convention
  // gets crowded out by a long system prompt.
  if (tool_calls.length === 0 && content) {
    const re = /```(?:json|xml|tool[_-]?call|javascript|js)?\s*(\{[\s\S]*?"name"\s*:[\s\S]*?\})\s*```/gi;
    let m: RegExpExecArray | null;
    let idx = 0;
    const matchedRanges: Array<[number, number]> = [];
    while ((m = re.exec(content)) !== null) {
      try {
        const obj = JSON.parse(m[1]) as Record<string, unknown>;
        const name = obj.name as string | undefined;
        const hasArgs = obj.arguments !== undefined || obj.parameters !== undefined;
        if (name && hasArgs) {
          tool_calls.push({
            id: `md_${idx++}`,
            function: { name, arguments: parseArgs(obj.arguments ?? obj.parameters) }
          });
          matchedRanges.push([m.index, m.index + m[0].length]);
        }
      } catch {
        // not a tool-call shaped JSON — skip
      }
    }
    if (tool_calls.length > 0) {
      // Strip matched blocks from content (walk from tail so indices stay valid)
      for (let i = matchedRanges.length - 1; i >= 0; i--) {
        const [s, e] = matchedRanges[i];
        content = content.slice(0, s) + content.slice(e);
      }
      content = content.trim();
    }
  }

  // Bare JSON fallback — last resort when model skips every fence/tag convention.
  if (tool_calls.length === 0 && content) {
    const found = findBareJsonCalls(content);
    if (found.length > 0) {
      for (let i = 0; i < found.length; i++) {
        tool_calls.push({
          id: `bare_${i}`,
          function: { name: found[i].name, arguments: parseArgs(found[i].args) }
        });
      }
      for (let i = found.length - 1; i >= 0; i--) {
        content = content.slice(0, found[i].start) + content.slice(found[i].end);
      }
      content = content.trim();
    }
  }

  return {
    role: 'assistant',
    content,
    tool_calls: tool_calls.length > 0 ? tool_calls : undefined
  };
}

function toWire(m: ChatMessage, fallbackCallId: string): Record<string, unknown> {
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: 'assistant',
      content: m.content ?? '',
      tool_calls: m.tool_calls.map((tc, i) => ({
        id: tc.id ?? `${fallbackCallId}_${i}`,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments ?? {})
        }
      }))
    };
  }
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.tool_call_id ?? fallbackCallId
    };
  }
  return { role: m.role, content: m.content };
}

export interface StreamHooks {
  onChunk?: (delta: string) => void;
  shouldAbort?: () => boolean;
}

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Network-level failures worth retrying
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|aborted/i.test(msg)) return true;
  // 5xx from server side
  if (/HTTP 5\d{2}/.test(msg)) return true;
  // 429 rate limit
  if (/HTTP 429/.test(msg)) return true;
  return false;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  allowRetry: boolean,
  onRetryInfo?: (attempt: number, err: unknown) => void
): Promise<Response> {
  let lastErr: unknown;
  const attempts = allowRetry ? RETRY_ATTEMPTS : 1;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const txt = await res.text();
        const err = new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 500)}`);
        if (allowRetry && i < attempts - 1 && isTransientError(err)) {
          lastErr = err;
          onRetryInfo?.(i + 1, err);
          await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * Math.pow(2, i)));
          continue;
        }
        throw err;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (!allowRetry || i >= attempts - 1 || !isTransientError(e)) throw e;
      onRetryInfo?.(i + 1, e);
      await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * Math.pow(2, i)));
    }
  }
  throw lastErr ?? new Error('LLM: unreachable');
}

export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: unknown[],
  stream?: StreamHooks
): Promise<ChatMessage> {
  const url = normalizeHost(cfg.host) + '/chat/completions';
  const streaming = Boolean(stream?.onChunk);
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map((m, i) => toWire(m, `call_${i}`)),
    temperature: cfg.temperature,
    max_tokens: cfg.maxOutput ?? 12000,
    stream: streaming
  };
  if (tools && tools.length > 0) body.tools = tools;

  // Streaming: can retry only the initial fetch (before any chunks delivered). We detect this
  // because once the SSE parser loop runs, partial output has already been handed to caller.
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body)
    },
    true,
    (attempt, err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Log to stderr for CLI visibility; webview shows nothing here — caller's onInfo could bridge.
      console.error(`[ollama] retry ${attempt}/${RETRY_ATTEMPTS - 1} after: ${msg.slice(0, 200)}`);
    }
  );

  if (!streaming) {
    const data = (await res.json()) as Record<string, unknown>;
    const choices = data.choices as Array<{ message?: Record<string, unknown> }> | undefined;
    const msg = choices?.[0]?.message;
    if (!msg) throw new Error('LLM: empty response (no choices[0].message)');
    return normalizeAssistant(msg);
  }

  // SSE streaming path
  if (!res.body) throw new Error('LLM: no response body for stream');
  const reader = (res.body as unknown as { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(): Promise<void> } }).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCallAccum: Array<{ id?: string; function: { name?: string; arguments?: string } }> = [];

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
    const choices = parsed.choices as Array<{ delta?: Record<string, unknown> }> | undefined;
    const delta = choices?.[0]?.delta;
    if (!delta) return;
    const deltaContent = delta.content;
    if (typeof deltaContent === 'string' && deltaContent.length > 0) {
      content += deltaContent;
      stream?.onChunk?.(deltaContent);
    }
    const deltaTools = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(deltaTools)) {
      for (const tc of deltaTools) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        if (!toolCallAccum[idx]) toolCallAccum[idx] = { function: {} };
        const entry = toolCallAccum[idx];
        if (typeof tc.id === 'string') entry.id = tc.id;
        const fn = tc.function as { name?: string; arguments?: string } | undefined;
        if (fn?.name) entry.function.name = fn.name;
        if (fn?.arguments) entry.function.arguments = (entry.function.arguments ?? '') + fn.arguments;
      }
    }
  };

  try {
    while (true) {
      if (stream?.shouldAbort?.()) {
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    if (buffer.trim()) processLine(buffer);
  } catch (e) {
    throw new Error(`LLM stream error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const finalMsg: Record<string, unknown> = { content };
  const nonEmptyTools = toolCallAccum.filter((tc) => tc && tc.function && tc.function.name);
  if (nonEmptyTools.length > 0) finalMsg.tool_calls = nonEmptyTools;
  return normalizeAssistant(finalMsg);
}

/**
 * Normalize a host URL so it always ends at /v1 (OpenAI-compat API base).
 * Accepts:
 *   "http://host:11434"        → "http://host:11434/v1"
 *   "http://host:11434/"       → "http://host:11434/v1"
 *   "http://host:11434/v1"     → "http://host:11434/v1"
 *   "http://host:11434/v1/"    → "http://host:11434/v1"
 */
function normalizeHost(host: string): string {
  const trimmed = host.replace(/\/+$/, '');
  return /\/v1$/i.test(trimmed) ? trimmed : trimmed + '/v1';
}

export async function probe(cfg: LlmConfig): Promise<string | null> {
  const url = normalizeHost(cfg.host) + '/models';
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` }
    });
    if (!res.ok) {
      const txt = await res.text();
      return `Probe failed: HTTP ${res.status} ${txt.slice(0, 200)}`;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const arr = (data.data ?? data.models) as Array<Record<string, unknown>> | undefined;
    const names = (arr ?? []).map((m) => (m.id as string) ?? (m.name as string) ?? '').filter(Boolean);
    const want = cfg.model.toLowerCase();
    const hit = names.find((n) => n.toLowerCase() === want);
    if (!hit) {
      return `Model "${cfg.model}" not on server. Available: ${names.join(', ') || '(none)'}`;
    }
    return null;
  } catch (e) {
    return `Cannot reach LLM at ${cfg.host}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
