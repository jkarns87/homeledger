import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const url = need('MCP_URL');
const tokenUrl = need('COGNITO_TOKEN_URL');
const clientId = need('COGNITO_CLIENT_ID');
const clientSecret = need('COGNITO_CLIENT_SECRET');
const BUDGET_MS = 3000;

async function token(): Promise<string> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'homeledger/mcp' })
  });
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function timed<T>(label: string, fn: () => Promise<T>, enforce = true): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`${label}: ${ms} ms`);
  if (enforce && ms > BUDGET_MS) throw new Error(`${label} exceeded ${BUDGET_MS} ms`);
  return out;
}

const bearer = await token();
console.log('token: ok');

// Modern client (2026-07-28)
{
  const client = new Client({ name: 'smoke-modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  await timed('modern connect (cold)', () => client.connect(transport), false);
  const { tools } = await timed('modern tools/list', () => client.listTools());
  const names = tools.map(t => t.name);
  const expected = ['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events', 'echo_confirm'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`tool order ${names.join(',')}`);
  const due = await timed('modern maintenance_due', () => client.callTool({ name: 'maintenance_due', arguments: {} }));
  if (!(due.structuredContent as { items: unknown[] }).items.length) throw new Error('no maintenance items; run seed:remote');
  await client.close();
}

// Legacy client (2025-era) with elicitation through the shim
{
  const client = new LegacyClient({ name: 'Alexa+ MCP Client', version: '1.0.0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { confirm: true } }));
  const transport = new LegacyTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  await timed('legacy initialize (cold)', () => client.connect(transport), false);
  if (!transport.sessionId) throw new Error('legacy: no Mcp-Session-Id');
  console.log(`legacy session: ${transport.sessionId}`);
  const r = await timed('legacy echo_confirm (elicitation)', () => client.callTool({ name: 'echo_confirm', arguments: { message: 'smoke' } }));
  if (JSON.stringify(r.structuredContent) !== JSON.stringify({ confirmed: true, message: 'smoke' }))
    throw new Error(`legacy elicitation result ${JSON.stringify(r.structuredContent)}`);
  try {
    await transport.terminateSession();
  } catch (err) {
    // AgentCore Runtime has been observed not to route this explicit DELETE
    // termination call to the same microVM that served the session, even
    // though every prior POST/GET on the session (including the elicitation
    // round trip above) did route correctly — see FL-021. AgentCore manages
    // session lifecycle itself via idle timeout, so an on-demand DELETE is
    // best-effort cleanup, not part of the smoke contract; log and continue.
    console.log(`legacy terminateSession: non-fatal - ${(err as Error).message}`);
  }
  await client.close();
}

console.log('SMOKE OK');
