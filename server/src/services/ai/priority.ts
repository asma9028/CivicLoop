import type { Severity } from '@prisma/client';

const severityWeight: Record<Severity, number> = {
  LOW: 20,
  MEDIUM: 45,
  HIGH: 72,
  CRITICAL: 95,
};

export interface PriorityInput {
  severity: Severity;
  safetyRisk: number;
  publicImpact: number;
  timeSensitivity: number;
  confidence: number;
}

export function calculatePriority(input: PriorityInput) {
  const components = {
    severity: severityWeight[input.severity],
    safety: clamp(input.safetyRisk),
    publicImpact: clamp(input.publicImpact),
    timeSensitivity: clamp(input.timeSensitivity),
    confidence: clamp(input.confidence),
  };
  const score = Math.round(
    components.severity * 0.3 +
    components.safety * 0.25 +
    components.publicImpact * 0.2 +
    components.timeSensitivity * 0.15 +
    components.confidence * 0.1,
  );
  const band = score >= 80 ? 'P1' : score >= 60 ? 'P2' : score >= 35 ? 'P3' : 'P4';
  return {
    score,
    band,
    breakdown: components,
    reasoning: `Severity (30%), safety risk (25%), public impact (20%), time sensitivity (15%), and analysis confidence (10%) produce a reproducible score of ${score}/100. This is a recommendation for human review, not an objective measurement.`,
  } as const;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
