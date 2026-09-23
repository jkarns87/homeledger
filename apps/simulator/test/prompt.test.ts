import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_WORDMARKS, VOICE_MAX_ITEMS, buildSystemPrompt } from '../src/server/prompt.js';

const NINE = [
  'list_appliances',
  'get_appliance',
  'maintenance_due',
  'log_maintenance',
  'recent_events',
  'ask_manual',
  'book_service',
  'get_visit',
  'echo_confirm'
];

describe('buildSystemPrompt', () => {
  it('names every tool it was given, so a new tool cannot go unmentioned', () => {
    const prompt = buildSystemPrompt({ today: '2026-09-21', toolNames: NINE });
    for (const name of NINE) expect(prompt, name).toContain(name);
  });

  it('names only the tools it was given, rules included', () => {
    // Both halves of this matter and the second is the one that bites. The
    // prompt carries per-tool guidance ("book_service will ask the person
    // questions through the screen"), and guidance for a tool the server is
    // not offering is an instruction to call something that does not exist -
    // against a server started without HOMELEDGER_DEV_TOOLS, or against any
    // future one that drops a tool. The rules are therefore emitted per tool,
    // not as a fixed block.
    const prompt = buildSystemPrompt({ today: '2026-09-21', toolNames: ['list_appliances'] });
    expect(prompt).toContain('list_appliances');
    expect(prompt).not.toContain('book_service');
    expect(prompt).not.toContain('ask_manual');
  });

  it('carries each tool-specific rule when that tool IS on offer', () => {
    // The other side of the test above, and it has to exist: deleting the two
    // conditional rule lines outright would satisfy "names only the tools it
    // was given" perfectly while quietly dropping the guidance that stops the
    // model typing the three booking questions itself.
    const prompt = buildSystemPrompt({ today: '2026-09-21', toolNames: NINE });
    expect(prompt).toContain('book_service will ask the person questions through the screen');
    expect(prompt).toContain('ask_manual returns source passages');
  });

  it('carries the date it was given', () => {
    expect(buildSystemPrompt({ today: '2026-10-22', toolNames: NINE })).toContain('2026-10-22');
  });

  it('states the five-option ceiling as a number, not as a word', () => {
    expect(VOICE_MAX_ITEMS).toBe(5);
    expect(buildSystemPrompt({ today: '2026-09-21', toolNames: NINE })).toContain('at most 5');
  });

  it('forbids reading JSON aloud', () => {
    expect(buildSystemPrompt({ today: '2026-09-21', toolNames: NINE }).toLowerCase()).toContain('never read json');
  });

  it('forbids answering from fixtures when a call fails, in those words', () => {
    const prompt = buildSystemPrompt({ today: '2026-09-21', toolNames: NINE });
    expect(prompt).toContain('fixtures');
    expect(prompt).toContain('Say the call failed');
  });

  it('tells the model the marketplace is sample data', () => {
    expect(buildSystemPrompt({ today: '2026-09-21', toolNames: NINE })).toContain('sample data');
  });
});

describe('wordmark guard', () => {
  it('lists the names this product must not wear', () => {
    // The exact list, because a length check passes after someone reduces it
    // to ['Amazon'] and drops the two marks that matter most. These three are
    // what spec section 2 names - "No Amazon or Alexa logos or wordmarks" -
    // plus the device family the frame imitates, so the expected value is
    // anchored to the spec rather than restated from the module under test.
    expect([...FORBIDDEN_WORDMARKS]).toEqual(['Alexa', 'Echo Show', 'Amazon']);
  });

  it('finds none of them anywhere under apps/simulator/src, comments included', async () => {
    // Comments included is not a detail. This guard reads source text, so a
    // doc comment naming the product fails it exactly as a rendered string
    // would - which is correct, because a filename, an asset name and a
    // comment are all places the mark can travel out of this repository. Every
    // module written before this task has to be clean by the time this runs:
    // `src/server/mcp.ts`'s class comment named the product in the draft of
    // this plan, and it is written one task earlier than this test.
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(full);
      }
      return files;
    };
    const offenders: string[] = [];
    for (const file of await walk(root)) {
      if (file.endsWith(join('server', 'prompt.ts'))) continue; // the list itself lives here
      const text = await readFile(file, 'utf8').then(t => t.toLowerCase());
      for (const mark of FORBIDDEN_WORDMARKS) if (text.includes(mark.toLowerCase())) offenders.push(`${file}: ${mark}`);
    }
    expect(offenders).toEqual([]);
  });
});
