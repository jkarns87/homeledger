import { readFileSync } from 'node:fs';

/** A Ring fixture's `payload` (Task 1). The wrapper's `source` names the Ring document it came from. */
export function fixture<T = unknown>(name: string): T {
  return (JSON.parse(readFileSync(new URL(`./fixtures/ring/${name}.json`, import.meta.url), 'utf8')) as { payload: T }).payload;
}
