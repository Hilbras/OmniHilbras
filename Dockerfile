# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY Kernel/API/package.json Kernel/API/
COPY Kernel/SDK Kernel/SDK
COPY Kernel/TokenSaver Kernel/TokenSaver
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules /app/node_modules
COPY . .
RUN pnpm build:sdk && pnpm build:token-saver && pnpm build:gateway

FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/Kernel/API/dist /app/Kernel/API/dist
COPY --from=build /app/Kernel/API/package.json /app/Kernel/API/
COPY --from=build /app/node_modules /app/node_modules
EXPOSE 8787
CMD ["node", "/app/Kernel/API/dist/src/main.js"]
