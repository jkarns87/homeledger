import { describe, expect, it } from 'vitest';
import { SMOKE_MANUAL_TITLE, buildSmokePdf } from '../seed-manual.js';

describe('buildSmokePdf', () => {
  it('starts with a PDF 1.4 header', () => {
    const pdf = Buffer.from(buildSmokePdf(['hello']));
    expect(pdf.subarray(0, 9).toString('latin1')).toBe('%PDF-1.4\n');
  });

  it('every xref row offset points at the exact byte position of its own "<n> 0 obj" header', () => {
    const pdf = Buffer.from(buildSmokePdf(['Error code F21 indicates a long drain time.']));
    const text = pdf.toString('latin1');

    const xrefOffset = Number(text.match(/startxref\n(\d+)\n/)?.[1]);
    expect(Number.isFinite(xrefOffset)).toBe(true);
    expect(text.slice(xrefOffset, xrefOffset + 4)).toBe('xref');

    const rows = text
      .slice(xrefOffset)
      .split('\n')
      .filter(line => /^\d{10} \d{5} [nf] $/.test(line));
    expect(rows).toHaveLength(6); // 1 free-list head (object 0) + 5 objects

    // Row 0 is the free-list placeholder ("0000000000 65535 f"); rows 1..5
    // are 1-indexed object offsets that must each land exactly on "<n> 0 obj".
    for (let objectNumber = 1; objectNumber < rows.length; objectNumber++) {
      const offset = Number(rows[objectNumber]?.slice(0, 10));
      const header = `${objectNumber} 0 obj`;
      expect(text.slice(offset, offset + header.length)).toBe(header);
    }
  });

  it('SMOKE_MANUAL_TITLE names the seeded document', () => {
    expect(SMOKE_MANUAL_TITLE).toBe('HomeLedger smoke test manual');
  });
});
