#!/usr/bin/env bash
# Run opencode against a local Ollama instance.
#
# Usage:
#   script/ollama.sh [opencode args...]
#
# Override any of these before invoking:
#   OLLAMA_MODEL      model name as registered in `ollama list` (default: qwen2.5-coder)
#   OLLAMA_NUM_CTX    context window in tokens (default: 32768)
#   OLLAMA_BASE_URL   Ollama OpenAI-compatible endpoint (default: http://localhost:11434/v1)
#
# Example:
#   OLLAMA_MODEL=qwen2.5-coder:32b OLLAMA_NUM_CTX=65536 script/ollama.sh

set -euo pipefail

export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5-coder}"
export OLLAMA_NUM_CTX="${OLLAMA_NUM_CTX:-32768}"
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434/v1}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
export OPENCODE_CONFIG="$repo_root/script/ollama.opencode.json"

exec bun run "$repo_root/packages/opencode/src/index.ts" "$@"
