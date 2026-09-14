FROM --platform=linux/arm64 node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/mcp-server/package.json apps/mcp-server/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY apps/mcp-server apps/mcp-server
RUN pnpm --filter @homeledger/core build && pnpm --filter @homeledger/mcp-server build
RUN pnpm --filter @homeledger/mcp-server --prod deploy --legacy /out

FROM --platform=linux/arm64 node:22-bookworm-slim
ENV NODE_ENV=production PORT=8000
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
