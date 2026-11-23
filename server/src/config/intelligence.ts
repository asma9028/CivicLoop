function positiveNumber(name: string, defaultValue: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive number no greater than ${max}`);
  }
  return value;
}

function positiveInteger(name: string, defaultValue: number, max: number) {
  const value = positiveNumber(name, defaultValue, max);
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number`);
  return value;
}

export const intelligenceConfig = {
  hotspotRadiusMeters: positiveNumber('INTELLIGENCE_HOTSPOT_RADIUS_METERS', 500, 10_000),
  hotspotMinIncidents: positiveInteger('INTELLIGENCE_HOTSPOT_MIN_INCIDENTS', 3, 100),
  publicHotspotMinIncidents: positiveInteger('INTELLIGENCE_PUBLIC_HOTSPOT_MIN_INCIDENTS', 5, 500),
  recurrenceRadiusMeters: positiveNumber('INTELLIGENCE_RECURRENCE_RADIUS_METERS', 250, 10_000),
  recurrenceWindowDays: positiveInteger('INTELLIGENCE_RECURRENCE_WINDOW_DAYS', 365, 3650),
  overdueHours: positiveInteger('INTELLIGENCE_OVERDUE_HOURS', 72, 24 * 365),
  riskWeights: {
    density: positiveInteger('INTELLIGENCE_RISK_WEIGHT_DENSITY', 30, 100),
    severity: positiveInteger('INTELLIGENCE_RISK_WEIGHT_SEVERITY', 25, 100),
    recurrence: positiveInteger('INTELLIGENCE_RISK_WEIGHT_RECURRENCE', 20, 100),
    overdue: positiveInteger('INTELLIGENCE_RISK_WEIGHT_OVERDUE', 15, 100),
    disputeReopen: positiveInteger('INTELLIGENCE_RISK_WEIGHT_DISPUTE_REOPEN', 10, 100),
  },
};

if (Object.values(intelligenceConfig.riskWeights).reduce((sum, weight) => sum + weight, 0) !== 100) {
  throw new Error('INTELLIGENCE_RISK_WEIGHT_* values must sum to 100');
}
