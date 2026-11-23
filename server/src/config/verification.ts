function configuredHours(name: string, defaultValue: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 24 * 365) {
    throw new Error(`${name} must be a whole number between 1 and 8760`);
  }
  return value;
}

export const verificationResponseHours = configuredHours('VERIFICATION_RESPONSE_HOURS', 72);
export const verificationDisputeEscalationHours = configuredHours('VERIFICATION_DISPUTE_ESCALATION_HOURS', 48);
export const verificationReviewOverdueHours = configuredHours('VERIFICATION_REVIEW_OVERDUE_HOURS', 72);
