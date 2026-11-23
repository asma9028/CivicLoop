import type { ActivityType, IncidentStatus, Prisma } from '@prisma/client';

const transitions: Record<IncidentStatus, readonly IncidentStatus[]> = {
  REPORTED: ['ACKNOWLEDGED', 'ON_HOLD', 'REJECTED', 'DUPLICATE'],
  ACKNOWLEDGED: ['IN_PROGRESS', 'ON_HOLD', 'REJECTED', 'DUPLICATE'],
  IN_PROGRESS: ['ON_HOLD', 'RESOLUTION_SUBMITTED', 'REJECTED', 'DUPLICATE'],
  RESOLUTION_SUBMITTED: ['VERIFICATION_PENDING'],
  VERIFICATION_PENDING: ['RESOLVED', 'REOPENED'],
  RESOLVED: [],
  REOPENED: ['ACKNOWLEDGED', 'IN_PROGRESS', 'ON_HOLD', 'REJECTED', 'DUPLICATE'],
  ON_HOLD: ['ACKNOWLEDGED', 'IN_PROGRESS', 'REJECTED', 'DUPLICATE'],
  REJECTED: [],
  DUPLICATE: [],
};

export class InvalidIncidentTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIncidentTransitionError';
  }
}

export function validIncidentTransitions(status: IncidentStatus) {
  return transitions[status];
}

export function assertIncidentTransition(
  current: IncidentStatus,
  target: IncidentStatus,
  reason?: string,
  duplicateOfIncidentId?: string,
) {
  if (!transitions[current].includes(target)) {
    throw new InvalidIncidentTransitionError(`Cannot change an incident from ${current} to ${target}`);
  }
  if ((target === 'ON_HOLD' || target === 'REJECTED' || target === 'DUPLICATE') && !reason?.trim()) {
    throw new InvalidIncidentTransitionError(`A reason is required to move an incident to ${target}`);
  }
  if (target === 'DUPLICATE' && !duplicateOfIncidentId) {
    throw new InvalidIncidentTransitionError('A related incident is required to mark this incident as a duplicate');
  }
  if (target !== 'DUPLICATE' && duplicateOfIncidentId) {
    throw new InvalidIncidentTransitionError('A related incident can only be supplied for a duplicate transition');
  }
}

export async function transitionIncident(
  tx: Prisma.TransactionClient,
  input: {
    incidentId: string;
    actorUserId: string;
    target: IncidentStatus;
    reason?: string;
    duplicateOfIncidentId?: string;
    activityType?: ActivityType;
    activityDescription?: string;
    metadata?: Prisma.InputJsonObject;
  },
) {
  const incident = await tx.incident.findUnique({
    where: { id: input.incidentId },
    select: { id: true, departmentId: true, status: true, acknowledgedAt: true },
  });
  if (!incident) throw new InvalidIncidentTransitionError('Incident not found');
  assertIncidentTransition(incident.status, input.target, input.reason, input.duplicateOfIncidentId);

  if (input.target === 'DUPLICATE') {
    const related = await tx.incident.findFirst({
      where: {
        id: input.duplicateOfIncidentId,
        departmentId: incident.departmentId,
        NOT: { id: incident.id },
      },
      select: { id: true },
    });
    if (!related) throw new InvalidIncidentTransitionError('The related incident must be a different incident in the same department');
  }

  const data: Prisma.IncidentUpdateManyMutationInput = {
    status: input.target,
    ...(input.target === 'ACKNOWLEDGED' ? { acknowledgedAt: incident.acknowledgedAt ?? new Date() } : {}),
    ...(input.target === 'ON_HOLD' ? { holdReason: input.reason!.trim() } : {}),
    ...(input.target === 'IN_PROGRESS' || input.target === 'ACKNOWLEDGED' ? { holdReason: null } : {}),
    ...(input.target === 'REJECTED' ? { rejectionReason: input.reason!.trim() } : {}),
    ...(input.target === 'DUPLICATE' ? { duplicateOfIncidentId: input.duplicateOfIncidentId } : {}),
    ...(input.target === 'RESOLUTION_SUBMITTED' ? { resolutionSubmittedAt: new Date() } : {}),
    ...(input.target === 'RESOLVED' ? { resolvedAt: new Date() } : {}),
    ...(input.target === 'REOPENED' ? { resolvedAt: null } : {}),
  };
  const changed = await tx.incident.updateMany({
    where: { id: incident.id, status: incident.status },
    data,
  });
  if (!changed.count) throw new InvalidIncidentTransitionError('The incident status changed while this action was being saved');
  await tx.incidentActivity.create({
    data: {
      incidentId: incident.id,
      actorUserId: input.actorUserId,
      activityType: input.activityType ?? (input.target === 'REJECTED'
        ? 'INCIDENT_REJECTED'
        : input.target === 'DUPLICATE'
          ? 'INCIDENT_DUPLICATED'
          : 'STATUS_CHANGED'),
      previousStatus: incident.status,
      newStatus: input.target,
      activityDescription: input.activityDescription ?? (input.target === 'DUPLICATE'
        ? `Incident linked as a duplicate. Reason: ${input.reason!.trim()}`
        : input.reason?.trim() || `Incident status changed to ${input.target.replaceAll('_', ' ').toLowerCase()}.`),
      metadata: {
        ...(input.reason ? { reason: input.reason.trim() } : {}),
        ...(input.duplicateOfIncidentId ? { duplicateOfIncidentId: input.duplicateOfIncidentId } : {}),
        ...input.metadata,
      },
    },
  });
}
