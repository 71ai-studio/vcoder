# Prompt-extraction review — vcoder

Đánh giá hàm "extract prompt" hiện có và đề xuất trả về đầy đủ chức năng + thêm API endpoint.

## 1. Hàm hiện tại

Repo có **hai** điểm "extract / build prompt" — không chia sẻ logic:

### A. `buildSystemPrompt(agent, rules)` — `src/ecc/loader.ts:122`

```ts
export function buildSystemPrompt(agent: AgentDef, rules: RuleDoc[]): string {
  const parts = [agent.systemPrompt];
  if (rules.length > 0) {
    parts.push('\n---\n# Project rules (always apply)\n');
    for (const r of rules) parts.push(`\n## ${r.name}\n${r.body}`);
  }
  return parts.join('\n');
}
```

**Output:** chỉ là `string` đã merge.

### B. `buildSystemPrompt(phaseBase, agentBody?, contextFiles?)` — `src/agent/orchestrator.ts:67`

Cùng tên nhưng signature khác — gộp `phase base + ECC agent body + workspace context files`. Cũng trả về `string`.

### C. Pipeline đi kèm

| Bước | Hàm | File | Output thiếu |
|---|---|---|---|
| Parse FM + body | `parseFile` | `src/ecc/frontmatter.ts:18` | OK — trả `ParsedDoc` đủ |
| Tạo `AgentDef` | `agentFromDoc` | `src/ecc/loader.ts:73` | OK |
| Load bundle | `loadEcc` | `src/ecc/loader.ts:91` | trả `{agents, commands, rules}` — không có index theo phase |
| Load CLAUDE.md/AGENTS.md | `loadContextFiles` | `src/ecc/context-files.ts:11` | trả `string` đã concat — mất tên file gốc, mất trạng thái truncated |
| Resolve phase agents | `resolvePhaseAgents` | `src/ecc/context-files.ts:39` | trả `Record<phase,string>` — mất tên agent thật, mất tools |
| Build prompt | `buildSystemPrompt` | (2 chỗ) | string |

## 2. Output đang **thiếu** gì

So với những thông tin caller sẽ cần (CLI, panel, API tương lai):

| Thông tin | Có trong output? | Caller phải tự lo |
|---|---|---|
| `systemPrompt` đã merge | ✅ |  |
| `agent.name` | ❌ | refer riêng `AgentDef` |
| `agent.description` | ❌ | tương tự |
| `agent.tools` (ECC → registry mapping) | ❌ | `cli-review.ts` filter lại bằng tay |
| `agent.model` (preference) | ❌ | bị bỏ ở biên |
| Source paths (debug) | ❌ | không trace được prompt từ file nào |
| Rules đã apply (tên + source) | ❌ | chỉ thấy text concatenated |
| Context files đã load (tên, bytes, truncated?) | ❌ | `loadContextFiles` chỉ trả string |
| Phase agent metadata | ❌ | `resolvePhaseAgents` strip còn body |
| Tool-call format directive (`<tool_call>...`) | ❌ | `cli-review.ts:baseSystemPrompt` tự append sau |
| Token estimate | ❌ | đã có `agent/token-estimate.ts` nhưng không gọi |
| Phase base text (READ/PLAN/EXECUTE/FIX) | ❌ | hard-coded trong `orchestrator.ts`, không expose |

**Hệ quả:** mỗi caller (`cli-do.ts`, `cli-review.ts`, `chat/panel.ts`) tự nối thêm phần riêng → 2 hàm `buildSystemPrompt` trùng tên + nhiều chỗ append `<tool_call>` directive lặp lại → khó debug "prompt thật gửi LLM trông thế nào".

## 3. Đề xuất: trả về đầy đủ chức năng

Thay 2 hàm `buildSystemPrompt` bằng **1 hàm `extractPrompt()`** trả về object có cấu trúc:

```ts
// src/ecc/extract-prompt.ts (mới)

export interface ExtractedPrompt {
  // Identity
  agent: { name: string; description: string; model?: string; source: string };

  // Final string ready-to-send (giữ tương thích các caller cũ)
  systemPrompt: string;

  // Components — để UI/log hiển thị, để API trả ra
  components: {
    agentBody: string;
    rules: Array<{ name: string; source: string; body: string }>;
    contextFiles: Array<{ path: string; bytes: number; truncated: boolean }>;
    phaseBase?: string;            // khi gọi từ orchestrator
    toolDirective?: string;        // <tool_call> format
  };

  // Tools — đã map sang registry name
  tools: string[];

  // Budget
  estimatedTokens: number;
  byteSize: number;

  // Trace
  sources: string[];               // tất cả file đã đọc
}

export interface ExtractPromptOptions {
  workspaceRoot: string;
  agentName: string;
  eccRoots?: string[];
  rules?: string[];                // optional whitelist; default = all
  contextPaths?: string[];         // default ["CLAUDE.md", "AGENTS.md"]
  contextMaxBytes?: number;
  phase?: 'READ' | 'PLAN' | 'EXECUTE' | 'FIX' | 'REVIEW';
  toolFormat?: 'native' | 'tool_call_xml';
}

export function extractPrompt(opts: ExtractPromptOptions): ExtractedPrompt;
```

Refactor checklist:
1. `loadContextFiles` trả thêm `LoadedFile[]` (path, bytes, truncated) bên cạnh string đã concat.
2. `resolvePhaseAgents` trả `Record<phase, AgentDef>` (giữ object, không strip).
3. `buildSystemPrompt` trong `loader.ts` deprecate → `extractPrompt()`.
4. `orchestrator.buildSystemPrompt` xoá; gọi `extractPrompt({ phase: 'PLAN', ... })`.
5. `cli-review.ts:baseSystemPrompt` xoá; `toolFormat: 'tool_call_xml'` lo việc append directive.

## 4. Đề xuất API endpoint

Hiện vcoder mới có CLI (`cli-do`, `cli-review`) + VS Code panel. Để các tool/agent ngoài (thử nghiệm prompt, dashboard, CI hook) gọi được, mở 1 HTTP server nhỏ (Node `http` hoặc `fastify`, bind `127.0.0.1`).

### Endpoints đề xuất

| Method | Path | Mục đích |
|---|---|---|
| `GET`  | `/api/v1/health` | liveness |
| `GET`  | `/api/v1/agents` | list agents (`name`, `description`, `tools`, `model`) |
| `GET`  | `/api/v1/agents/:name` | chi tiết 1 agent (raw `systemPrompt`, frontmatter, source) |
| `GET`  | `/api/v1/rules` | list rules theo namespace (common/python/...) |
| `POST` | `/api/v1/prompts/extract` | **chính** — trả `ExtractedPrompt` |
| `POST` | `/api/v1/prompts/preview` | giống extract nhưng truncate string xuống N bytes |
| `POST` | `/api/v1/prompts/diff` | so sánh 2 agent / 2 phase, trả unified diff của `systemPrompt` |
| `GET`  | `/api/v1/phases` | list phase base prompts của orchestrator |

### Request mẫu

```http
POST /api/v1/prompts/extract
Content-Type: application/json
Authorization: Bearer ${VDSX_API_TOKEN}

{
  "workspaceRoot": "d:/Projects/foo",
  "agent": "typescript-reviewer",
  "phase": "EXECUTE",
  "contextPaths": ["CLAUDE.md", "AGENTS.md"],
  "rules": ["common/git-conventions", "typescript/strict-mode"],
  "toolFormat": "tool_call_xml",
  "contextMaxBytes": 8000
}
```

### Response = `ExtractedPrompt` ở mục 3.

### Bảo mật / vận hành

- Bind `127.0.0.1` only; token bắt buộc qua env `VDSX_API_TOKEN`.
- Rate-limit theo IP (1 RPS đủ cho tool nội bộ).
- Mode "dry-run" mặc định — endpoint này KHÔNG gọi LLM, chỉ build prompt. Endpoint chạy LLM (`/api/v1/run`) là task tách riêng.
- Log đầy đủ `sources[]` để audit prompt nào đã được build cho ai.

### Wiring

```ts
// src/server/index.ts (mới)
import http from 'http';
import { extractPrompt } from '../ecc/extract-prompt';

export function startServer(port = 7173) { /* ... */ }
```

CLI flag mới: `node dist/server.js --port 7173`.

## 5. Tóm tắt action items

1. Tạo `src/ecc/extract-prompt.ts` với `ExtractedPrompt` interface + `extractPrompt()`.
2. Refactor `loadContextFiles` / `resolvePhaseAgents` để giữ metadata.
3. Xoá `buildSystemPrompt` trùng tên — caller dùng `extractPrompt().systemPrompt`.
4. Tích hợp `agent/token-estimate.ts` vào output.
5. Thêm `src/server/` expose 8 endpoint ở mục 4 (auth bằng bearer token, bind localhost).
6. Doc + sample `curl` trong README.

Tổng effort ước tính: ~4–6h cho refactor + ~2h cho server tối thiểu.
