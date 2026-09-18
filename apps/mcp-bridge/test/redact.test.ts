import { afterEach, describe, expect, it } from 'vitest';
import { REDACTION, logDiagnostic, protectSecret, redact, resetProtectedSecrets, setDiagnosticWriter } from '../src/redact.js';

afterEach(() => {
  resetProtectedSecrets();
});

describe('redact', () => {
  it('replaces a registered secret everywhere it appears', () => {
    protectSecret('s3cr3t-client-secret-value');
    expect(redact('basic s3cr3t-client-secret-value and again s3cr3t-client-secret-value')).toBe(`basic ${REDACTION} and again ${REDACTION}`);
  });

  it('leaves text alone when nothing is registered', () => {
    expect(redact('AgentCore returned 403')).toBe('AgentCore returned 403');
  });

  it('refuses to register a value short enough to match ordinary prose', () => {
    // An 8-character floor is what stops `protectSecret('')` — or a truncated
    // read of a secret — turning every diagnostic into a row of [redacted].
    protectSecret('');
    protectSecret('abc');
    expect(redact('abc appears in this sentence and so does an empty string')).toBe('abc appears in this sentence and so does an empty string');
  });

  it('replaces the longer of two overlapping secrets whole', () => {
    protectSecret('token-abcdefgh');
    protectSecret('token-abcdefgh-extended-suffix');
    expect(redact('bearer token-abcdefgh-extended-suffix')).toBe(`bearer ${REDACTION}`);
  });
});

describe('logDiagnostic', () => {
  it('scrubs registered secrets out of every line it writes', () => {
    const lines: string[] = [];
    const previous = setDiagnosticWriter(line => lines.push(line));
    try {
      protectSecret('bearer-token-that-must-not-appear');
      logDiagnostic('upstream said: bearer-token-that-must-not-appear');
    } finally {
      setDiagnosticWriter(previous);
    }
    expect(lines).toEqual([`[homeledger-bridge] upstream said: ${REDACTION}`]);
  });

  it('prefixes every line so the owner can tell bridge output from the client’s own logging', () => {
    const lines: string[] = [];
    const previous = setDiagnosticWriter(line => lines.push(line));
    try {
      logDiagnostic('ready');
    } finally {
      setDiagnosticWriter(previous);
    }
    expect(lines).toEqual(['[homeledger-bridge] ready']);
  });
});
