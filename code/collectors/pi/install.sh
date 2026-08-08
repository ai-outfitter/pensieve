#!/usr/bin/env sh
# Install the Pi collector. Run as root.
#
# Pi has no managed configuration scope. Settings resolve from ~/.pi/agent/ and
# project .pi/ only, and `--no-extensions` disables extension discovery
# outright. So there is no install that a session cannot override, and the
# strongest available authority is a root-owned launcher wrapper placed ahead of
# the real binary on PATH.
#
# The collector therefore reports install_scope "launcher", not "managed". A
# verifier reads that and knows Pi collection on this machine was advisory.
# Presenting it as authoritative is forbidden. CLC-001.2.4, CLC-001.2.7.
#
# Usage: install.sh <path-to-bundled-extension-js>
set -eu

EXTENSION="${1:?usage: install.sh <path-to-pi-extension.js>}"

if [ "$(id -u)" != "0" ]; then
	echo "install.sh must run as root: the wrapper must sit where the session cannot rewrite it" >&2
	exit 1
fi

# Pi may be on PATH, or bundled inside the Outfitter install and not exported —
# the published Outfitter image ships it at
# /usr/local/lib/node_modules/@ai-outfitter/outfitter/node_modules/.bin/pi.
# A wrapper that only checks PATH silently skips the collector there.
REAL_PI="${PI_BIN:-$(command -v pi || true)}"
if [ -z "$REAL_PI" ]; then
	for candidate in \
		/usr/local/lib/node_modules/@ai-outfitter/outfitter/node_modules/.bin/pi \
		/usr/lib/node_modules/@ai-outfitter/outfitter/node_modules/.bin/pi; do
		if [ -x "$candidate" ]; then
			REAL_PI="$candidate"
			break
		fi
	done
fi
if [ -z "$REAL_PI" ]; then
	echo "pi not found on PATH or in an Outfitter install; set PI_BIN to its path" >&2
	exit 1
fi
if [ "$REAL_PI" = "/usr/local/bin/pi" ]; then
	echo "/usr/local/bin/pi is already the wrapper; nothing to do" >&2
	exit 0
fi

install -D -o root -g root -m 0644 "$EXTENSION" /opt/pensieve/collectors/pi/extension.js

cat > /usr/local/bin/pi <<WRAPPER
#!/usr/bin/env sh
# Root-owned launcher wrapper. Loads the Pensieve collector for every pi run
# started through PATH. A user who invokes ${REAL_PI} directly, or who passes
# --no-extensions, is not collected — and the absence of a session record is
# treated as unattested by the sink, never as clean. CLC-001.8.2.
PENSIEVE_INSTALL_SCOPE=launcher \\
exec ${REAL_PI} --extension /opt/pensieve/collectors/pi/extension.js "\$@"
WRAPPER
chown root:root /usr/local/bin/pi
chmod 0755 /usr/local/bin/pi

# Sticky-bit shared directories, like /tmp. The agent must be able to create
# AND list its own spooled records, so a drop-box mode (0733) is wrong: drain
# has to scan the directory. The security property is that the session cannot
# alter or remove the COLLECTOR (/opt/pensieve, /etc), not that it cannot see
# its own pending evidence.
install -d -o root -g root -m 1777 /var/lib/pensieve/spool
install -d -o root -g root -m 1777 /var/lib/pensieve/state

echo "pi collector installed at launcher scope (wrapping ${REAL_PI})"
