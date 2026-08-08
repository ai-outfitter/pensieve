#!/usr/bin/env sh
# Build the three collectors.
#
# Claude Code and Codex collectors compile to standalone binaries so the target
# machine needs no runtime — a managed hook that depends on the session's own
# toolchain is a managed hook the session can break. The Pi collector bundles to
# one JavaScript file because Pi loads it in process.
set -eu

OUT="${1:-dist}"
cd "$(dirname "$0")/.."
mkdir -p "$OUT"

bun build collectors/claude/src/hook.ts --compile --outfile "$OUT/pensieve-claude-hook"
bun build collectors/codex/src/hook.ts --compile --outfile "$OUT/pensieve-codex-hook"
bun build collectors/pi/src/extension.ts --target=bun --outfile "$OUT/pi-extension.js"

ls -l "$OUT"
