# HomeLedger

The household's operating record, exposed to an assistant through an MCP server.
Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ and Ring tracks, AWS Builder mini-challenge).

- Design: `docs/superpowers/specs/2026-09-13-homeledger-design.md`
- Friction log: `FRICTION-LOG.md`

## Prerequisites

Node 22, pnpm 10, Docker, Terraform >= 1.10, AWS CLI v2.

## Local development

```bash
pnpm install
docker compose up -d           # DynamoDB Local on :8000
cp .env.example .env
pnpm -r test
```

## Run the MCP server locally

```bash
docker compose up -d                                  # DynamoDB Local on :8000
pnpm --filter @homeledger/core seed:local             # table + seed household
cd apps/mcp-server
PORT=8010 HOUSEHOLD_ID=hh_harlow TABLE_NAME=homeledger DYNAMO_ENDPOINT=http://127.0.0.1:8000 \
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 HOMELEDGER_DEV_TOOLS=1 pnpm dev
npx @modelcontextprotocol/inspector                   # connect to http://127.0.0.1:8010/mcp
```

Container (what AgentCore runs):

```bash
docker build --platform linux/arm64 -f apps/mcp-server/Dockerfile -t homeledger-mcp:dev .
docker run --rm -p 8010:8000 -e HOUSEHOLD_ID=hh_harlow -e MEMORY_REPO=1 homeledger-mcp:dev
```
