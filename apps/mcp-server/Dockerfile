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
# The base image's globally-installed npm CLI (and the corepack/npx shims
# that ship with it) is dead weight here: the container only ever runs
# `node dist/index.js`, nothing shells out to npm or npx at runtime. It also
# carries its own bundled transitive dependencies (brace-expansion,
# ip-address, pacote, picomatch, sigstore) that trivy flags as HIGH in this
# image on an otherwise-clean scan. Removed as root, before USER node, since
# /usr/local is not writable by the unprivileged user.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
