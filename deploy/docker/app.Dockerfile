# Shared runtime image for api, worker, migrate and mock-ai.
FROM oven/bun:1.4-debian AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN rm -rf apps/web/src apps/web/public && bun install --frozen-lockfile --production --ignore-scripts
# Two optional CLIs, each left out unless its build setting is true ("Sign in with ChatGPT" and the API-key
# providers need neither):
#   WITH_CLAUDE_CODE  Claude Code (~550 MB), run by "Claude subscription (Claude Code)" on a `claude setup-token`.
#   WITH_CODEX_CLI    Codex (~610 MB), run by "ChatGPT subscription (Codex)" on the server's `codex:login`.
ARG WITH_CLAUDE_CODE=false
ARG WITH_CODEX_CLI=false
# "On" means what the app's config reads as true (1/true/yes/on, any case), so build and app always agree.
RUN on() { case "$(printf %s "$1" | tr A-Z a-z)" in 1|true|yes|on) return 0;; *) return 1;; esac; }; \
    on "$WITH_CLAUDE_CODE" || rm -rf node_modules/.bun/@anthropic-ai+claude-agent-sdk-linux*; \
    on "$WITH_CODEX_CLI" || rm -rf node_modules/.bun/@openai+codex@*-linux*

FROM oven/bun:1.4-debian AS runtime
ARG WITH_CLAUDE_CODE=false
ARG WITH_CODEX_CLI=false
ENV NODE_ENV=production CLAUDE_CODE_CLI=$WITH_CLAUDE_CODE CODEX_CLI=$WITH_CODEX_CLI
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core fonts-comic-neue tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f
WORKDIR /app
# Bun uses isolated installs: each workspace package keeps its own node_modules symlinks, so copy the whole tree.
COPY --from=deps /app /app
# Stamped after the code is copied, so it re-runs exactly when the code changes: the time means "this code was built
# then", and an unchanged tree keeps its stamp instead of pretending to be a new build. The image has no .git, so the
# commit arrives as a build argument (GIT_SHA=$(git rev-parse --short HEAD) docker compose build).
ARG GIT_SHA=""
RUN bun -e 'const p = require("/app/package.json"); require("fs").writeFileSync("/app/build-info.json", JSON.stringify({ version: p.version, builtAt: new Date().toISOString(), sha: process.env.GIT_SHA || null }))'
RUN mkdir -p /data/assets /data/tmp /data/agent-login && chown -R bun:bun /data
USER bun
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "apps/api/src/server.ts"]
