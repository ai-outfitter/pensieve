# The container you exec into and run outfitter in.
#
# Stage 1 builds the collectors with Bun. Stage 2 starts FROM the published
# Outfitter image and installs them AS ROOT into the system locations each
# harness reads before any user or project configuration. The final image drops
# back to uid 1000, which is the Outfitter runtime contract — so the agent that
# runs here cannot rewrite or remove its own collector, which is the entire
# point of a managed install. CLC-001.2.1, CLC-001.2.2.
FROM oven/bun:1 AS collectors
WORKDIR /build
COPY code/package.json code/bun.lock ./
COPY code/server/package.json server/
COPY code/importer/package.json importer/
COPY code/collectors/core/package.json collectors/core/
COPY code/collectors/claude/package.json collectors/claude/
COPY code/collectors/codex/package.json collectors/codex/
COPY code/collectors/pi/package.json collectors/pi/
RUN bun install --frozen-lockfile
COPY code/ ./
RUN sh scripts/build-collectors.sh dist

FROM ghcr.io/ai-outfitter/outfitter:latest
USER root

COPY --from=collectors /build/dist/ /tmp/pensieve-dist/
COPY code/collectors/claude/ /tmp/pensieve-src/claude/
COPY code/collectors/codex/ /tmp/pensieve-src/codex/
COPY code/collectors/pi/ /tmp/pensieve-src/pi/

# Claude Code and Codex: managed scope, highest precedence, not overridable by
# the session. Pi: no managed scope exists, so a root-owned launcher wrapper is
# the strongest available authority and the collector reports itself
# `launcher`, not `managed`. CLC-001.2.7.
RUN set -eux; \
	sh /tmp/pensieve-src/claude/install.sh /tmp/pensieve-dist/pensieve-claude-hook; \
	sh /tmp/pensieve-src/codex/install.sh /tmp/pensieve-dist/pensieve-codex-hook; \
	sh /tmp/pensieve-src/pi/install.sh /tmp/pensieve-dist/collectors/pi; \
	rm -rf /tmp/pensieve-src /tmp/pensieve-dist

USER 1000:1000
WORKDIR /workspace

# The published image sets ENTRYPOINT ["outfitter"]. This is a workbench you
# exec into, so hold the container open and let the operator run outfitter by
# hand: docker compose exec workbench outfitter
ENTRYPOINT []
CMD ["sleep", "infinity"]
