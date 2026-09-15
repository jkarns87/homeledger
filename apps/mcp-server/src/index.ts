import { createApp } from './app.js';
import { depsFromEnv } from './deps.js';

function parseAllowedHosts(raw: string | undefined): string[] | 'any' | undefined {
  // '*' disables Host-header validation (see createApp's 'any' handling);
  // unset keeps createApp's own default list; anything else is a literal
  // comma-separated list.
  if (raw === '*') return 'any';
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const port = Number(process.env.PORT ?? 8000);
const allowedHosts = parseAllowedHosts(process.env.ALLOWED_HOSTS);

const deps = await depsFromEnv(process.env);
const { app, close } = createApp(deps, { allowedHosts });
const server = app.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ msg: 'listening', port, path: '/mcp', devTools: deps.devTools }));
});

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ msg: 'shutdown', signal }));
  const forceExit = setTimeout(() => {
    console.log(JSON.stringify({ msg: 'shutdown-timeout', signal }));
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  // Stop accepting new connections first; the drain callback only fires once
  // every open connection ends, which closing the legacy/modern transports
  // below (open GET/SSE streams included) is what actually triggers.
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
  await close();
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
