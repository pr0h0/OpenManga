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
# A template: the image's entrypoint writes conf.d/default.conf from it at start, filling in only ASSET_CSP_ORIGIN
# (the bucket origin S3 downloads redirect to, added to the app's CSP; empty for local storage).
ENV NGINX_ENVSUBST_FILTER=^ASSET_CSP_ORIGIN$ ASSET_CSP_ORIGIN=""
COPY deploy/nginx/default.conf /etc/nginx/templates/default.conf.template
COPY --from=web /app/apps/web/dist /usr/share/nginx/html/app
