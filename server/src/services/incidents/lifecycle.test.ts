import { describe, expect, it } from 'vitest';
import { assertIncidentTransition, validIncidentTransitions } from './lifecycle.js';

describe('authority incident lifecycle', () => {
  it('allows operational transitions and limits verification outcomes to the pending state', () => {
    expect(validIncidentTransitions('REPORTED')).toContain('ACKNOWLEDGED');
    expect(validIncidentTransitions('IN_PROGRESS')).toContain('RESOLUTION_SUBMITTED');
    expect(validIncidentTransitions('IN_PROGRESS')).not.toContain('VERIFICATION_PENDING');
    expect(validIncidentTransitions('RESOLUTION_SUBMITTED')).toEqual(['VERIFICATION_PENDING']);
    expect(validIncidentTransitions('REOPENED')).toContain('IN_PROGRESS');
    expect(validIncidentTransitions('ON_HOLD')).toContain('IN_PROGRESS');
    expect(validIncidentTransitions('VERIFICATION_PENDING')).toEqual(['RESOLVED', 'REOPENED']);
    expect(() => assertIncidentTransition('VERIFICATION_PENDING', 'RESOLVED')).not.toThrow();
    expect(() => assertIncidentTransition('VERIFICATION_PENDING', 'REOPENED')).not.toThrow();
  });

  it('requires reasons for hold, rejection, and duplicate transitions', () => {
    expect(() => assertIncidentTransition('REPORTED', 'ON_HOLD')).toThrow(/reason is required/i);
    expect(() => assertIncidentTransition('REPORTED', 'REJECTED', '  ')).toThrow(/reason is required/i);
    expect(() => assertIncidentTransition('REPORTED', 'DUPLICATE', 'Related issue')).toThrow(/related incident is required/i);
  });

  it('rejects invalid transitions and extraneous duplicate links', () => {
    expect(() => assertIncidentTransition('RESOLVED', 'IN_PROGRESS')).toThrow(/cannot change/i);
    expect(() => assertIncidentTransition('REPORTED', 'ACKNOWLEDGED', undefined, 'clabc12345678901234567890')).toThrow(/only be supplied/i);
    expect(() => assertIncidentTransition('REPORTED', 'DUPLICATE', 'Same issue', 'clabc12345678901234567890')).not.toThrow();
  });
});
