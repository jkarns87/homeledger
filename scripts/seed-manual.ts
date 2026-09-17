import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDynamoRepository } from '@homeledger/core';
import { reportIngestionSkipped, uploadManual } from './manuals.js';

const need = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

export const SMOKE_MANUAL_TITLE = 'HomeLedger smoke test manual';

const LINES = [
  'HomeLedger smoke test manual',
  '',
  'Error code F21 indicates a long drain time. The washer could not pump',
  'the water out within eight minutes. Check the drain hose for kinks and',
  'clean the drain pump filter behind the lower access panel.',
  '',
  'This document exists only so the deployed smoke test can prove that',
  'ask_manual reaches the real Bedrock Knowledge Base.'
];

/** Escapes the three characters that are special inside a PDF literal string. */
function pdfText(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * A minimal, single-page PDF 1.4 built by hand so the smoke fixture needs no
 * PDF library. Object offsets are computed as the body is assembled, which is
 * the only part of the format that cannot be written as a constant.
 */
export function buildSmokePdf(lines: string[]): Uint8Array {
  const content = ['BT', '/F1 12 Tf', '72 720 Td', '16 TL', ...lines.map(line => `(${pdfText(line)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// Guarded like manuals.ts's own entrypoint check: this makes buildSmokePdf
// and SMOKE_MANUAL_TITLE importable (by scripts/test/seed-manual.test.ts, and
// any future caller) without requiring AWS_REGION/HOUSEHOLD_ID/TABLE_NAME or
// touching the network merely to import this module.
//
// realpathSync on process.argv[1] is required, not cosmetic
// (task-13-review.md Finding 2, IMPORTANT): Node's ESM loader resolves
// import.meta.url through symlinks, but process.argv[1] is the path as
// typed. On a symlinked workspace (a self-hosted runner, a container
// bind-mount, macOS /tmp -> /private/tmp) the two disagree without it, this
// whole block is silently skipped, and the process exits 0 having seeded
// nothing. This script is the producer of the exact document
// smoke.ts's assertManualPassages requires, so a silent exit-0 no-op here
// makes the smoke fail later blaming the wrong thing entirely - it points
// at KNOWLEDGE_BASE_ID and Terraform rather than at the seeding step that
// quietly did nothing.
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntrypoint) {
  const region = need('AWS_REGION');
  const householdId = need('HOUSEHOLD_ID');
  const tableName = need('TABLE_NAME');

  const repo = createDynamoRepository({ tableName, householdId, region });
  const washer = (await repo.listAppliances({ category: 'laundry' }))[0];
  if (!washer) throw new Error('no laundry appliance in the table; run seed:remote first');

  const result = await uploadManual({
    applianceId: washer.id,
    title: SMOKE_MANUAL_TITLE,
    pdf: buildSmokePdf(LINES),
    pages: 1,
    region,
    householdId,
    tableName,
    bucket: need('MANUALS_BUCKET'),
    knowledgeBaseId: need('KNOWLEDGE_BASE_ID'),
    dataSourceId: need('DATA_SOURCE_ID')
  });

  // Three outcomes, not two. `uploadManual` throws for every ingestion
  // failure except the one account-wide Bedrock block it can positively
  // identify (see isBedrockAccountBlock), so reaching this line at all means
  // either the document is ingested or it is uploaded-and-waiting. The
  // difference is stated in the log rather than smoothed over, because
  // "seeded" reading the same for both is exactly how a run that proved
  // nothing gets mistaken for a run that proved something.
  if (result.ingestion === 'skipped-bedrock-blocked') {
    reportIngestionSkipped();
    console.log(`uploaded (not ingested) ${result.docId} for ${washer.name} (${washer.id})`);
  } else {
    console.log(`seeded ${result.docId} for ${washer.name} (${washer.id})`);
  }
}
