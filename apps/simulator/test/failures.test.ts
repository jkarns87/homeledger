import { describe, expect, it } from 'vitest';
import { NOTHING_RETRIEVED, explainFailure } from '../src/lib/failures.js';

describe('explainFailure', () => {
  it('explains the account-wide model block when ask_manual cannot retrieve', () => {
    const explained = explainFailure(
      'ask_manual',
      'Invalid input or configuration provided. Error 002: Access to Bedrock models is not allowed for this account'
    );
    expect(explained.title).toBe('The manuals could not be searched');
    expect(explained.detail).toContain('model access is blocked on this AWS account');
    expect(explained.detail).toContain('Nothing was retrieved');
  });

  it('ends every explanation, on every branch, with the sentence that forbids reading it as an empty result', () => {
    // The property, not a sample of it. A branch that dropped this sentence
    // would be a failure a reader could round off into "there is nothing
    // there", which is precisely what happened twice (FL-039) - and the
    // per-branch assertions below each cover one branch, so only this one
    // fails when a FOURTH branch is added without it.
    const cases: Array<[string, string]> = [
      ['ask_manual', 'Access to Bedrock models is not allowed for this account'],
      ['get_visit', 'HTTP 404: Session not found'],
      ['log_maintenance', 'Tool log_maintenance not found'],
      ['list_appliances', ''],
      ['', 'something nobody predicted']
    ];
    for (const [tool, message] of cases) expect(explainFailure(tool, message).detail, `${tool}/${message}`).toContain(NOTHING_RETRIEVED);
  });

  it('never describes a blocked retrieval as an empty one', () => {
    const explained = explainFailure('ask_manual', 'Access to Bedrock models is not allowed for this account');
    // The positive half first, and it is the half that carries the weight: a
    // rewording that loses the cause fails here whatever words it chose. The
    // denylist below is a second net for four phrasings that have actually
    // been written in this repository, not the assertion itself - a denylist
    // alone would pass "the manual had nothing on that", which is the same
    // lie in words nobody listed.
    expect(explained.detail).toContain('model access is blocked on this AWS account');
    expect(explained.detail).toContain(NOTHING_RETRIEVED);
    for (const phrase of ['no results', 'nothing found', 'no passages were found', 'not in the manual']) {
      expect(explained.detail.toLowerCase(), phrase).not.toContain(phrase);
    }
  });

  it('explains a lost session as a connection that expired, for any tool', () => {
    const explained = explainFailure('get_visit', 'HTTP 404: Session not found');
    expect(explained.title).toBe('The connection to the household server expired');
    expect(explained.detail).toContain('retried once');
    expect(explained.detail).toContain('Nothing was retrieved');
  });

  it('passes an unrecognised failure through verbatim rather than dressing it up', () => {
    const explained = explainFailure('log_maintenance', 'Tool log_maintenance not found');
    expect(explained.title).toBe('log_maintenance failed');
    expect(explained.detail).toContain('Tool log_maintenance not found');
    expect(explained.detail).toContain('Nothing was retrieved');
  });

  it('does not claim a Bedrock block for a tool that does not use one', () => {
    // The block explanation is keyed on the message, not only on the tool, so
    // an unrelated ask_manual failure is not mislabelled.
    expect(explainFailure('ask_manual', 'Tool ask_manual not found').title).toBe('ask_manual failed');
  });
});
