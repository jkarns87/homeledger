import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { requireEnv } from '../env.js';

export interface AuthorizerResult {
  principalId: string;
  policyDocument: { Version: '2012-10-17'; Statement: Array<{ Action: 'execute-api:Invoke'; Effect: 'Allow' | 'Deny'; Resource: string }> };
}

export function bearerFrom(headers: Record<string, string | undefined> | undefined): string | null {
  const value = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  const match = value?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

const policy = (effect: 'Allow' | 'Deny', resource: string): AuthorizerResult => ({
  principalId: 'homeledger-display',
  policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }] }
});

export async function authorize(
  deps: { verify: (token: string) => Promise<void> },
  event: { headers?: Record<string, string | undefined>; methodArn: string }
): Promise<AuthorizerResult> {
  const token = bearerFrom(event.headers);
  if (!token) return policy('Deny', event.methodArn);
  try {
    await deps.verify(token);
    return policy('Allow', event.methodArn);
  } catch (err) {
    console.log(JSON.stringify({ msg: 'ws-authorizer', outcome: 'denied', reason: err instanceof Error ? err.name : 'unknown' }));
    return policy('Deny', event.methodArn);
  }
}

let verifier: { verify: (token: string) => Promise<unknown> } | undefined;

/** The simulator's client-credentials access token: this user pool, this client, the homeledger/mcp scope. */
export const handler = async (event: { headers?: Record<string, string | undefined>; methodArn: string }): Promise<AuthorizerResult> => {
  verifier ??= CognitoJwtVerifier.create({
    userPoolId: requireEnv('COGNITO_USER_POOL_ID'),
    tokenUse: 'access',
    clientId: requireEnv('COGNITO_CLIENT_ID'),
    scope: 'homeledger/mcp'
  });
  return authorize({ verify: async token => void (await verifier!.verify(token)) }, event);
};
