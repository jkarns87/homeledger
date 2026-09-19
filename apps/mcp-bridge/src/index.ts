#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { createAwsDiscoveryApi, discoverSetupValues } from './discover.js';
import { Bridge, createLineReader } from './proxy.js';
import { logDiagnostic } from './redact.js';
import { SecretError, createSecretsManagerReader, resolveClientSecret } from './secret.js';
import type { SetupValues } from './setup.js';
import {
  PLATFORM_ROOT,
  createTerraformReader,
  readSetupValues,
  renderSetup,
  resolveSetupIdentity,
  resolveSetupSource,
  terraformFailureMessage
} from './setup.js';
import { createTokenSource } from './token.js';

/** `<repo>/apps/mcp-bridge/{src,dist}/index.{ts,js}` -> `<repo>`. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function printSetup(): Promise<void> {
  const identity = resolveSetupIdentity(process.env);
  const source = resolveSetupSource(process.argv, process.env);

  let values: SetupValues;
  if (source === 'terraform') {
    try {
      values = await readSetupValues(createTerraformReader(resolve(repoRoot, PLATFORM_ROOT)));
    } catch (err) {
      throw new Error(terraformFailureMessage(err));
    }
  } else {
    values = await discoverSetupValues(await createAwsDiscoveryApi(identity), identity);
  }

  process.stdout.write(
    renderSetup({
      values,
      entrypoint: resolve(repoRoot, 'apps/mcp-bridge/dist/index.js'),
      region: identity.region,
      profile: identity.profile,
      profileFromEnvironment: identity.profileFromEnvironment
    })
  );
}

async function runBridge(): Promise<void> {
  const config = loadConfig(process.env);
  const secret = await resolveClientSecret(config, () => createSecretsManagerReader(config));
  const tokens = createTokenSource({ tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret: secret, scope: config.scope });
  // Minted before a single byte of MCP traffic moves, so that a bad client id,
  // a wrong scope, or an unreachable token endpoint is reported as one line at
  // startup rather than as a failure inside the owner's first tool call.
  await tokens.get();
  logDiagnostic(
    `ready: endpoint ${new URL(config.mcpUrl).host}, client ${config.clientId}, region ${config.region}, secret from ${config.clientSecretFromEnv ? 'HOMELEDGER_COGNITO_CLIENT_SECRET' : `Secrets Manager (${config.secretId})`}, runtime session ${config.agentCoreSessionId ? 'pinned' : 'unpinned'}`
  );

  const bridge = new Bridge({
    url: config.mcpUrl,
    token: () => tokens.get(),
    invalidateToken: () => tokens.invalidate(),
    agentCoreSessionId: config.agentCoreSessionId,
    standaloneStream: config.standaloneStream,
    // stdout is the protocol channel. Nothing else in this program writes to it.
    write: line => process.stdout.write(`${line}\n`),
    log: logDiagnostic
  });

  // Not awaited, and that is the design: see Bridge's class comment. A booking
  // conversation has an answer going up while the question's own request is
  // still open, so the read loop must never block on one message.
  const onChunk = createLineReader(line => {
    void bridge.handleClientMessage(line).catch(err => logDiagnostic(`unhandled relay failure: ${err instanceof Error ? err.message : String(err)}`));
  });
  process.stdin.on('data', onChunk);

  const stop = async (): Promise<void> => {
    await bridge.close();
    process.exit(0);
  };
  process.stdin.on('end', () => void stop());
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

try {
  if (process.argv.includes('--print-setup')) await printSetup();
  else await runBridge();
} catch (err) {
  // Startup failures get the operator's sentence and nothing else. A stack
  // trace here would be the bridge answering "your SSO session expired" with
  // forty lines of AWS SDK internals.
  if (err instanceof ConfigError || err instanceof SecretError) logDiagnostic(err.message);
  else logDiagnostic(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
