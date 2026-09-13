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
