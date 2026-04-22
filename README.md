# VDS-X

Local AI coding agent as a VSCode extension. Powered by **Ollama** (Qwen2.5-Coder 14B) and the **ECC (everything-claude-code)** architecture at **Layer B** — loads ECC agents, commands, and rules, maps Claude Code tool names to the local tool registry, and runs a tool-using agent loop.

## Stack

- TypeScript + VSCode Extension API
- OpenAI-compatible client (pure `fetch`) → `http://192.168.1.220:11434` — server is actually **llama.cpp** with OpenAI-compat `/v1/chat/completions`, not Ollama
- Model: `Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf` (on RTX 3060)
- Bearer API key auth required
- `gray-matter` for YAML frontmatter
- Tool registry: `read_file`, `write_file`, `edit_file`, `bash`, `grep`, `glob`

## Server quirks (important)

The server at 192.168.1.220:11434 identifies as `llamacpp` (`system_fingerprint: b13-...`):

- **Requires `Authorization: Bearer <key>`** — `vdsx.ollama.apiKey` must be set.
- **Returns OpenAI format** (`choices[0].message.content`), not Ollama format.
- **Does NOT emit structured `tool_calls[]`** with Qwen2.5-Coder (server likely not started with `--jinja`). Instead the model writes inline XML: `<tools>{"name":"...", "arguments":{...}}</tools>` inside `message.content`.
- `src/agent/ollama.ts` has a **fallback parser** that extracts both `<tool_call>` and `<tools>` XML blocks into our internal `tool_calls` shape, so the loop works regardless.
- `num_ctx` setting is ignored by this server (context is fixed at llama.cpp startup via `-c`). Kept in settings for portability.

## Setup

```bash
cd d:/Projects/vds-x
npm install
npm run build        # bundles to dist/extension.js
```

Confirm the server is reachable (with your bearer token):

```bash
curl -H "Authorization: Bearer <your-key>" http://192.168.1.220:11434/v1/models
```

Quick smoke test of the tool-calling path:

```bash
VDSX_KEY=<your-key> node scripts/smoke.js
# expect "TOOL CALLS DETECTED: 1"
```

## Run

1. Open `d:/Projects/vds-x` in VSCode.
2. Press **F5** — opens an Extension Development Host window.
3. In the dev window, open a project folder (e.g. `d:/Projects/everything-claude-code` to exercise ECC loading).
4. Run command **VDS-X: Open Chat** (Ctrl+Shift+P).
5. Pick an agent from the dropdown (loaded from `.claude/agents/*.md`) or leave empty for default.
6. Type a request, Ctrl+Enter to send.

## Settings (`settings.json`)

```json
{
  "vdsx.ollama.host": "http://192.168.1.220:11434",
  "vdsx.ollama.model": "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
  "vdsx.ollama.apiKey": "llm-apikey-...",
  "vdsx.ollama.numCtx": 65536,
  "vdsx.ollama.temperature": 0.2,
  "vdsx.eccPaths": [".claude", "~/.claude"],
  "vdsx.maxIterations": 20,
  "vdsx.autoApprove": ["read_file", "grep", "glob"]
}
```

## ECC integration (Layer B)

`src/ecc/loader.ts` scans each `vdsx.eccPaths` root and collects:

- `agents/*.md` → `AgentDef { name, description, systemPrompt, tools[], model }`
- `commands/*.md` → `CommandDef` (registered but not yet wired into UI)
- `rules/**/*.md` → appended into system prompt

### Claude → VDS-X tool name mapping

`src/ecc/tool-mapping.ts` — ECC agents declare tools in Claude Code's PascalCase (`tools: [Read, Edit, Bash]`). We map:

| Claude name   | VDS-X registry |
|---------------|----------------|
| `Read`        | `read_file`    |
| `Write`       | `write_file`   |
| `Edit`        | `edit_file`    |
| `MultiEdit`   | `edit_file`    |
| `Bash`        | `bash`         |
| `Grep`        | `grep`         |
| `Glob`        | `glob`         |
| `WebFetch`, `WebSearch`, `Task`, `TodoWrite`, `NotebookEdit`, `SlashCommand`, `BashOutput`, `KillBash` | (dropped — out of MVP scope) |

When an ECC agent is selected, the loop only exposes its declared tools to the model.

## Architecture

```
extension.ts
  └─ ChatPanel (webview)
       ├─ loads EccBundle at open + on "Reload ECC"
       ├─ user types → runAgent(messages, opts)
       │    └─ loop: ollama.chat → assistant.tool_calls → run handler → append result → repeat
       ├─ approval dialog via vscode.window.showWarningMessage
       └─ streams updates back to webview
```

## Not in MVP

- Streaming tool calls (Ollama returns them only at end of message — fine for now)
- Subagent / `Task` tool (ECC Layer C)
- Hook engine (PreToolUse, PostToolUse, SessionStart, Stop)
- Slash command palette (commands/ are loaded but not invocable from UI yet)
- Inline diff preview (approval shows raw path + byte count only)
- Session persistence across restarts
- Markdown rendering in webview

## Known rough edges

- Local tool use is flakier than Claude. If the model emits malformed JSON for arguments, the tool returns an error and the loop continues — model usually recovers.
- `num_ctx=65536` on Qwen2.5-Coder:14b Q4 uses a lot of VRAM; on 12GB (RTX 3060) this works but leaves little headroom. Drop to 32768 if OOM.
- Webview uses `retainContextWhenHidden: true`; history stays until you close the panel.

## Next steps

Step 1 (this scaffold): ✅
Step 2: streaming assistant text to UI
Step 3: slash command palette wired to `commands/*.md`
Step 4: inline diff preview before `write_file` / `edit_file`
Step 5: session persistence + Stop hook equivalent
