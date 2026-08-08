#!/usr/bin/env sh
# Install the Codex collector at managed scope. Run as root.
#
# Codex marks hooks from a system, MDM, or requirements.toml source as managed:
# trusted by policy, and not disableable from the user hook browser.
# `allow_managed_hooks_only = true` additionally drops user, project, and plugin
# hook configuration. CLC-001.2.6.
#
# VERIFY BEFORE PRODUCTION USE: the managed config directory and the hooks.json
# schema are read from Codex's own documentation rather than measured against a
# running instance. Confirm both against the Codex version you deploy, and
# amend CLC-001.7.1 if they differ.
#
# Usage: install.sh <path-to-compiled-hook-binary>
set -eu

BINARY="${1:?usage: install.sh <path-to-pensieve-codex-hook>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CODEX_ETC="${CODEX_MANAGED_DIR:-/etc/codex}"

if [ "$(id -u)" != "0" ]; then
	echo "install.sh must run as root: the point of a managed install is that the session cannot write it" >&2
	exit 1
fi

install -D -o root -g root -m 0755 "$BINARY" /opt/pensieve/bin/pensieve-codex-hook

install -d -o root -g root -m 0755 "$CODEX_ETC"
install -o root -g root -m 0644 "$HERE/hooks.json" "$CODEX_ETC/hooks.json"
install -o root -g root -m 0644 "$HERE/requirements.toml" "$CODEX_ETC/requirements.toml"

install -d -o root -g root -m 0733 /var/lib/pensieve/spool
install -d -o root -g root -m 0733 /var/lib/pensieve/state

echo "codex collector installed at managed scope (${CODEX_ETC})"
