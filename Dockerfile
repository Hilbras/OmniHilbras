# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
# Pinned to the version CI uses and the lockfile records. `pnpm@latest` in a build that then installs
# from a committed lockfile means the toolchain reading the lockfile is whatever npm published that day.
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY Kernel/API/package.json Kernel/API/
COPY Kernel/SDK Kernel/SDK
COPY Kernel/TokenSaver Kernel/TokenSaver
COPY Kernel/Tools Kernel/Tools
COPY cli/package.json cli/
RUN pnpm install --frozen-lockfile
COPY . .
# The published CLI already proves how to produce one runtime file with every workspace package
# bundled. Reusing it keeps the image and the npm package on the same artifact instead of maintaining
# two dependency closures that can drift.
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The explicit container opt-in allows a non-loopback bind and a non-loopback Host. The default host
# remains 127.0.0.1 in a normal install; this image must be reachable through its published port.
ENV OMNIHILBRAS_CONTAINER=1
ENV OMNIHILBRAS_HOST=0.0.0.0
COPY --from=build /app/cli/server/gateway.mjs /app/gateway.mjs
COPY --from=build /app/Kernel/API/locales /app/locales
EXPOSE 20138
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:20138/health >/dev/null || exit 1
CMD ["node", "/app/gateway.mjs"]