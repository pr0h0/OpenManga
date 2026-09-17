FROM oven/bun:1.3-debian AS web
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --ignore-scripts
RUN cd apps/web && bun run build

FROM nginx:1.31-alpine
COPY deploy/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=web /app/apps/web/dist /usr/share/nginx/html/app
