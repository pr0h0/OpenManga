FROM oven/bun:1.4-debian AS web
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --ignore-scripts
# The web bundle bakes in its own build stamp (vite.config.ts); the commit comes in the same way as the app image's.
ARG GIT_SHA=""
RUN cd apps/web && bun run build

FROM nginx:1.31-alpine
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=web /app/apps/web/dist /usr/share/nginx/html/app
