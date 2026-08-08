#!/usr/bin/env sh
# Install the Claude Code collector at managed scope. Run as root.
#
# `/etc/claude-code/managed-settings.d/` has the highest settings precedence in
# Claude Code and cannot be overridden by user, project, or local settings, so
# a session cannot remove this hook. CLC-001.2.1, CLC-001.2.2.
#
# Usage: install.sh <path-to-compiled-hook-binary>
set -eu

BINARY="${1:?usage: install.sh <path-to-pensieve-claude-hook>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" != "0" ]; then
	echo "install.sh must run as root: the point of a managed install is that the session cannot write it" >&2
	exit 1
fi

install -D -o root -g root -m 0755 "$BINARY" /opt/pensieve/bin/pensieve-claude-hook

# Managed settings on Linux and WSL. macOS uses
# /Library/Application Support/ClaudeCode/managed-settings.d/ and Windows uses
# C:\Program Files\ClaudeCode\managed-settings.d\.
install -d -o root -g root -m 0755 /etc/claude-code/managed-settings.d
install -o root -g root -m 0644 \
	"$HERE/managed-settings.pensieve.json" \
	/etc/claude-code/managed-settings.d/pensieve.json

# Spool and state are root-owned but group-writable by the agent's group, so a
# non-root session can append evidence without being able to rewrite the
# installed collector.
install -d -o root -g root -m 0733 /var/lib/pensieve/spool
install -d -o root -g root -m 0733 /var/lib/pensieve/state

echo "claude-code collector installed at managed scope"
