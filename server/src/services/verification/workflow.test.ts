import { describe, expect, it } from 'vitest';
import { citizenResponseOutcome, independentReviewOutcome } from './workflow.js';

describe('verification workflow outcomes', () => {
  it('only considers an explicit citizen confirmation a verified resolution', () => {
    expect(citizenResponseOutcome('CONFIRM')).toEqual({
      caseStatus: 'VERIFIED',
      actionType: 'CITIZEN_CONFIRMED',
      incidentTarget: 'RESOLVED',
    });
    for (const decision of ['ISSUE_REMAINS', 'INCOMPLETE', 'EVIDENCE_MISMATCH', 'REQUEST_FURTHER_ACTION'] as const) {
      expect(citizenResponseOutcome(decision)).toEqual({
        caseStatus: 'DISPUTED',
        actionType: 'CITIZEN_DISPUTED',
        incidentTarget: null,
      });
    }
  });

  it('keeps additional evidence requests open and requires explicit independent outcomes', () => {
    expect(independentReviewOutcome('REQUEST_EVIDENCE')).toEqual({
      caseStatus: 'REVIEW_REQUIRED',
      actionType: 'REVIEW_REQUESTED_EVIDENCE',
      incidentTarget: null,
    });
    expect(independentReviewOutcome('CONFIRM').incidentTarget).toBe('RESOLVED');
    expect(independentReviewOutcome('REOPEN')).toEqual({
      caseStatus: 'REOPENED',
      actionType: 'REVIEW_REOPENED',
      incidentTarget: 'REOPENED',
    });
  });
});
