# Playwright runner image (bun + Chromium + system deps). Used by `scripts/e2e.sh`.
FROM oven/bun:1.4-debian
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bunx playwright@1.63.0 install --with-deps chromium && chmod -R a+rx /ms-playwright
WORKDIR /repo
