# Changelog

Ghi chép các thay đổi đáng chú ý. Format: [Keep a Changelog](https://keepachangelog.com/),
versioning theo [SemVer](https://semver.org/).

## [Unreleased]

### Đề xuất (chưa implement)

- **Shared-context orchestrator**: refactor từ phase-state-machine (fresh context mỗi phase)
  sang single-conversation model (append-only messages[]). Benefit: coherence, cache hit,
  ~50% ít code. Risk: context bloat, context poisoning nếu format xấu. Cần helper
  `Conversation` class + compact-at-task-boundary + cached_tokens logging.
- **Final-verify step** (nếu giữ architecture hiện tại): chạy test 1 lần cuối sau khi
  plan execute xong, re-mark các task failed do cascade thành passed. Gỡ false-fail
  không đụng fix loop.
- **Tighten plan prompt** thành 1-3 tasks: đã apply ở 0.5.0 nhưng cần đo thêm.

---

## [0.5.0] - 2026-04-22

### Added

- **ECC phase agents integration** — orchestrator tự động load ECC agent prompts vào 3 phase:
  - `plan` → [`planner`](../everything-claude-code/agents/planner.md)
  - `execute` → [`code-architect`](../everything-claude-code/agents/code-architect.md)
  - `fix` → [`build-error-resolver`](../everything-claude-code/agents/build-error-resolver.md)
  - Setting `vdsx.phaseAgents` override mapping. Setting empty string để dùng prompt generic.
- **Auto-load workspace context files** — khi chạy `/do` hoặc chat, scan `CLAUDE.md` +
  `AGENTS.md` ở workspace root, inject vào system prompt. Cap 8KB tổng.
  Setting `vdsx.contextFiles: ["CLAUDE.md", "AGENTS.md"]`.
- **`max_tokens: 12000` output cap** — mỗi LLM call giờ có hard cap output tokens để
  chặn runaway generation. Setting `vdsx.ollama.maxOutput`. Soft cap — response ngắn
  vẫn tự dừng ở EOS.
- Helper `src/ecc/context-files.ts`: `loadContextFiles()` + `resolvePhaseAgents()`.

### Changed

- `LlmConfig` thêm optional `maxOutput?: number`.
- Orchestrator `OrchestratorOptions` thêm `phaseAgents`, `contextFiles`.
- Plan prompt được tighten: "Prefer 1-3 tasks, combine same-file tasks, don't create
  'write tests' tasks when test_command exists".

### Infrastructure

- Server `192.168.1.220` đang chạy `llama-server` với `--ctx-size 49152` (48k).
- Thử 64k: boot OK (VRAM 11831/79 MiB free) nhưng CUDA OOM khi prompt > 15k tokens →
  PM2 auto-restart. Revert về 48k làm ceiling an toàn trên RTX 3060 12GB.
- Backup start script: `swap_managed_start.sh.bak-20260421-155910`.

### Security

- Rotate/scrub `VDSX_KEY` khỏi repo trước khi push (đã xoá hardcode trong `scripts/smoke.js`).

---

## [0.4.0] - 2026-04-21 — Orchestrator (`/do`)

### Added

- **Agentic orchestrator** (`src/agent/orchestrator.ts`) implement 6 phase:
  READ → PLAN → (user approval) → EXECUTE → TEST → FIX → REPORT.
- **JSON plan schema** — strict object: `{ summary, test_command, tasks: [{id, title, description, files, acceptance}] }`.
  Parser tolerant (strip fences, find first/last brace, fallback to manual bracket match).
- **Checklist markdown render** — plan hiển thị dạng `* [ ] tN — title` theo yêu cầu user.
  Report cũng dùng format này với `[x]`/`[-]`/`[ ]` markers.
- **Fix loop** cap 3 retries/task — sau mỗi test fail, gọi `phaseFix` sinh hint ngắn
  (≤150 words) về root cause, dùng làm priorFailureHint cho lần execute tiếp.
- **Chat panel `/do <goal>` command** — dùng `vscode.window.showInformationMessage`
  modal hỏi Approve/Reject plan.
- **Headless CLI**: `dist/cli-do.js <workspace> "<goal>" [--auto-approve]`.

### Design decisions

- **Không diff preview**: user approve plan 1 lần, sau đó auto-apply edits. Đơn giản hoá
  UX, tránh prompt mệt mỏi.
- **Plan JSON internal, render markdown**: tốt cho orchestrator parse + đẹp cho user xem.

### Verified

- Sandbox test: goal "Create lib.js that exports hello() returning 'hi' so npm test passes"
  → 3 tasks, t1 retry 1 lần, final PASS, `npm test` output `OK`.

---

## [0.3.0] - 2026-04-21 — Headless CLI review + split security

### Added

- `src/cli-review.ts` — CLI wrapper chạy ECC reviewer agent headless. Usage:
  `node dist/cli-review.js <target-dir> [agent-name] [--deep] [--split]`.
- **`--deep` mode** — cho phép `bash` tool với allowlist hẹp: `npx tsc`, `npx eslint`,
  `npm run lint|typecheck`, `git status|diff|log|show`, `ls`, `cat`, `head`, `wc`, `find`.
  Denied commands: write/network/arbitrary.
- **`--split` mode** (chỉ cho security-reviewer) — chia audit thành 5 category
  (secrets / cmd-injection / eval-RCE / path-traversal / weak-crypto) chạy tuần tự.
  Mỗi category = 1 `runAgent` gọi độc lập với prompt hẹp + max 6 iterations.
  Auto-verdict cuối: BLOCK/WARN/APPROVE dựa trên severity.
- **Intent-driven prompt** cho security reviewer — mô tả category bằng natural language
  thay vì đưa bash command template (Qwen 14B sẽ echo template nếu có sẵn).

### Findings từ real test

- `vgolf/web` (Next.js 16 + TS): 5 categories trong 30.6s, 2 findings Math.random() trong
  mock endpoint (HIGH technically, LOW thực tế — `fakeRevenue` demo data).
- `vdscode` (local AI coder monorepo): 60.4s, 2 real findings:
  - API key hardcode tại `packages/cli/src/config/ConfigManager.ts:21`
  - Path traversal tại `packages/core/src/skills/UserSkillStore.ts:16/75/88` (skillId không sanitize).

---

## [0.2.0] - 2026-04-21 — Multi-tier tool-call parser + caps

### Added

- **4-tier tool-call parser** (`src/agent/ollama.ts: normalizeAssistant`) xử lý Qwen 14B
  emit tool call theo nhiều format trong cùng 1 session:
  1. Native `tool_calls[]` field (OpenAI structured, chỉ có khi `tool_choice: required`)
  2. Inline XML: `<tool_call>`, `<tools>`, `<function-calls>`, `<function_calls>`, v.v.
     (regex generic match bất kỳ tag nào wrap `{"name": ...}`)
  3. Markdown fenced blocks: ```json / ```xml / ```tool_call / ```javascript / ```js
  4. Bare JSON object với manual brace-matching (escape + string-aware)
- **`max_tokens` plumbing** vào `/v1/chat/completions` body.

### Changed

- **Tool output caps** để tránh context overflow với ctx 48k:
  - `read_file`: max 12KB / 400 lines, trả hint `[showing lines X-Y of Z, use offset=…]`
  - `bash`: max 8KB (từ 32KB)
  - `grep`: max 200 matches, line clip 180 chars, output cap 10KB
- `fs-util.ts`: `resolveInside()` chặn path escape khỏi workspace root.

### Fixed

- Context overflow khi read file 229KB (`vgolf/web/app/rooms/.../sessions/page.tsx`) →
  server trả `400 exceed_context_size_error`. Cap file reads gỡ vấn đề này.

---

## [0.1.0] - 2026-04-21 — Initial scaffold

### Added

- VSCode extension skeleton: `package.json` manifest, `esbuild` bundler,
  `.vscode/launch.json` + `tasks.json` cho F5 debug.
- **Chat panel** (`src/chat/panel.ts`) — WebviewPanel với input, message list,
  agent dropdown, reload ECC button. Handle messages: send/stop/selectAgent/reloadEcc.
- **Agent loop** (`src/agent/loop.ts`) — tool-use loop: LLM reply → extract tool_calls
  → approve → execute tool → append result → repeat. Cap 20 iterations default.
- **Tool registry** (`src/agent/tools/`):
  - `read_file`, `write_file`, `edit_file` — file ops với approval cho write/edit
  - `bash` — spawn với timeout + approval
  - `grep` — regex scan, skip node_modules/.git/dist
  - `glob` — pattern match *, **, ?
- **ECC loader** (`src/ecc/loader.ts`) — scan `.claude/` (workspace root + `~/.claude`),
  parse `agents/*.md`, `commands/*.md`, `rules/**/*.md` với gray-matter.
- **Claude → VDS-X tool mapping** (`src/ecc/tool-mapping.ts`):
  - `Read` → `read_file`, `Write` → `write_file`, `Edit`/`MultiEdit` → `edit_file`
  - `Bash` → `bash`, `Grep` → `grep`, `Glob` → `glob`
  - `WebFetch`, `WebSearch`, `Task`, `TodoWrite`, `NotebookEdit` → dropped
- Settings: `vdsx.ollama.host`, `vdsx.ollama.model`, `vdsx.ollama.apiKey`, `vdsx.eccPaths`,
  `vdsx.maxIterations`, `vdsx.autoApprove`.

### Changed

- Ban đầu dùng `ollama` npm package → phát hiện server 192.168.1.220 là **llama.cpp**
  (`system_fingerprint: b13-c2eee86`), không phải Ollama thật. Response format OpenAI
  (`choices[0].message.content`), không phải Ollama (`message.content`).
- **Swap sang pure `fetch`** client OpenAI-compatible, bỏ `ollama` npm dependency.
  Bundle giảm 186kb → 153kb.
- Model default: `qwen2.5-coder:14b` → `Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf`
  (exact tag từ `/v1/models`).

### Fixed

- API key required — server 401 nếu không có Bearer token. Thêm setting
  `vdsx.ollama.apiKey`, gửi header `Authorization: Bearer <key>` mỗi request.
- Context window setting ban đầu 65536 → giảm còn 32768 khớp server (sau này bump 49152
  ở 0.5.0 sau khi PM2 restart với `--ctx-size 49152`).

---

## Referenced links

- Project: [d:/Projects/vds-x](.)
- ECC source: [d:/Projects/everything-claude-code](../everything-claude-code)
- Server: `192.168.1.220:11434` (llama.cpp, Qwen2.5-Coder-14B-Instruct-Q4_K_M)
