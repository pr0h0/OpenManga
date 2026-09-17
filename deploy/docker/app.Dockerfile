# Shared runtime image for api, worker, migrate and mock-ai.
FROM oven/bun:1.4-debian AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN rm -rf apps/web/src apps/web/public && bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4-debian AS runtime
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core fonts-comic-neue tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f
WORKDIR /app
# Bun uses isolated installs: each workspace package keeps its own node_modules symlinks, so copy the whole tree.
COPY --from=deps /app /app
RUN mkdir -p /data/assets /data/tmp && chown -R bun:bun /data
USER bun
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "apps/api/src/server.ts"]
