/**
 * Read per invocation, never at import: a handler module is loaded before its
 * environment is known in tests, and a missing variable must fail the one
 * invocation with a message naming it, not the cold start with a stack trace.
 */
export class EventsConfigError extends Error {}

export function requireEnv(name: string, source: NodeJS.ProcessEnv = process.env): string {
  const value = source[name]?.trim();
  if (!value) throw new EventsConfigError(`${name} is not set.`);
  return value;
}

export function optionalEnv(name: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = source[name]?.trim();
  return value ? value : undefined;
}

export function flagEnv(name: string, source: NodeJS.ProcessEnv = process.env): boolean {
  const value = source[name]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
