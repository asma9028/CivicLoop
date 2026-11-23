import type { IncidentStatus, VerificationActionType, VerificationCaseStatus, VerificationDecision } from '@prisma/client';

export function citizenResponseOutcome(decision: VerificationDecision): {
  caseStatus: VerificationCaseStatus;
  actionType: VerificationActionType;
  incidentTarget: IncidentStatus | null;
} {
  if (decision === 'CONFIRM') {
    return { caseStatus: 'VERIFIED', actionType: 'CITIZEN_CONFIRMED', incidentTarget: 'RESOLVED' };
  }
  return { caseStatus: 'DISPUTED', actionType: 'CITIZEN_DISPUTED', incidentTarget: null };
}

export function independentReviewOutcome(decision: 'CONFIRM' | 'REOPEN' | 'REQUEST_EVIDENCE'): {
  caseStatus: VerificationCaseStatus;
  actionType: VerificationActionType;
  incidentTarget: IncidentStatus | null;
} {
  switch (decision) {
    case 'CONFIRM':
      return { caseStatus: 'VERIFIED', actionType: 'REVIEW_CONFIRMED', incidentTarget: 'RESOLVED' };
    case 'REOPEN':
      return { caseStatus: 'REOPENED', actionType: 'REVIEW_REOPENED', incidentTarget: 'REOPENED' };
    case 'REQUEST_EVIDENCE':
      return { caseStatus: 'REVIEW_REQUIRED', actionType: 'REVIEW_REQUESTED_EVIDENCE', incidentTarget: null };
  }
}
