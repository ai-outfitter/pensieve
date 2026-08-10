#!/usr/bin/env sh
# Build the three collectors.
#
# Claude Code and Codex collectors compile to standalone binaries so the target
# machine needs no runtime — a managed hook that depends on the session's own
# toolchain is a managed hook the session can break. The Pi collector bundles to
# a Node ESM directory because Pi loads it in process under Node.
set -eu

OUT="${1:-dist}"
cd "$(dirname "$0")/.."
mkdir -p "$OUT"

bun build collectors/claude/src/hook.ts --compile --outfile "$OUT/pensieve-claude-hook"
bun build collectors/codex/src/hook.ts --compile --outfile "$OUT/pensieve-codex-hook"
PI_OUT="$OUT/collectors/pi"
mkdir -p "$PI_OUT"
bun build collectors/pi/src/extension.ts --target=node --format=esm --outfile "$PI_OUT/extension.js"
printf '%s\n' '{"type":"module","main":"extension.js"}' > "$PI_OUT/package.json"

ls -l "$OUT"
