/**
 * The last line of defence for the project's hard rule that the Cognito client
 * secret and the bearer token minted from it never reach any output.
 *
 * The first line of defence is that no call site interpolates either value into
 * a string at all: `token.ts` builds the `Authorization` header inline and never
 * formats it, `secret.ts` returns the secret and never logs its own return
 * value, and `proxy.ts` logs statuses and JSON-RPC methods rather than headers.
 * This module exists because "no call site does X" is a property that a future
 * edit can quietly break, while a redaction net applied at the single stderr
 * writer keeps holding. Both halves are tested: `test/redact.test.ts` proves the
 * net, `test/token.test.ts` and `test/secret.test.ts` prove the individual error
 * paths carry nothing to redact in the first place.
 *
 * stdout is NOT routed through here, and must never be: on a stdio MCP server
 * stdout is the protocol channel, so the only thing that may ever be written to
 * it is a JSON-RPC message (`proxy.ts`'s `writeMessage`). Every diagnostic in
 * this program goes to stderr, which Claude Code captures into its MCP log.
 */

/**
 * Registered secrets, longest first so that a value which contains another
 * (the Basic credential contains neither the raw id nor the raw secret after
 * base64, but a token refresh registers a second bearer while the first is
 * still registered) is replaced whole rather than in fragments.
 */
const secrets: string[] = [];

/**
 * Below this length a "secret" is more likely to be a fragment that appears in
 * ordinary text — redacting it would corrupt every diagnostic line instead of
 * protecting anything, and an empty string would match at every index.
 */
const MIN_REDACTABLE_LENGTH = 8;

export const REDACTION = '[redacted]';

/** Registers a value to be scrubbed from every stderr line for the life of the process. */
export function protectSecret(value: string | undefined | null): void {
  if (typeof value !== 'string' || value.length < MIN_REDACTABLE_LENGTH) return;
  if (secrets.includes(value)) return;
  secrets.push(value);
  secrets.sort((a, b) => b.length - a.length);
}

/** Replaces every registered secret with `[redacted]`. Total: any input, including one with no secret in it, comes back a string. */
export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTION);
  return out;
}

/** Test seam only. The running bridge never forgets a secret. */
export function resetProtectedSecrets(): void {
  secrets.length = 0;
}

export type Writer = (line: string) => void;

const defaultWriter: Writer = line => {
  process.stderr.write(`${line}\n`);
};

let writer: Writer = defaultWriter;

/** Test seam: redirects diagnostics so a test can assert on what was written. Returns the previous writer. */
export function setDiagnosticWriter(next: Writer): Writer {
  const previous = writer;
  writer = next;
  return previous;
}

/**
 * The only diagnostic channel in this program. Every caller goes through here
 * precisely so the redaction cannot be bypassed by a new call site that reaches
 * for `console.error` out of habit — and `[homeledger-bridge]` prefixes every
 * line so the owner can tell these apart from Claude Code's own MCP log noise.
 */
export function logDiagnostic(message: string): void {
  writer(redact(`[homeledger-bridge] ${message}`));
}
