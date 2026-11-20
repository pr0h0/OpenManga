# Shared runtime image for api, worker, migrate and mock-ai.
FROM oven/bun:1.4-debian AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN rm -rf apps/web/src apps/web/public && bun install --frozen-lockfile --production --ignore-scripts
# The Claude Code and Codex CLIs (~1.2 GB) are only for the "Claude subscription" and "ChatGPT subscription (Codex)"
# providers. Left out unless asked for; "Sign in with ChatGPT" and the API-key providers do not need them.
ARG WITH_AGENT_CLIS=false
RUN if [ "$WITH_AGENT_CLIS" != "true" ]; then \
      rm -rf node_modules/.bun/@anthropic-ai+claude-agent-sdk-linux* node_modules/.bun/@openai+codex@*-linux*; \
    fi

FROM oven/bun:1.4-debian AS runtime
ARG WITH_AGENT_CLIS=false
ENV NODE_ENV=production AGENT_CLIS=$WITH_AGENT_CLIS
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
