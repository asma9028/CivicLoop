import type { IncidentCategory } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import type { DepartmentRecommendation } from './types.js';

const departmentCodes: Record<IncidentCategory, string | null> = {
  ROAD: 'ROADS',
  WASTE: 'WASTE',
  WATER: 'WATER',
  DRAINAGE: 'DRAINAGE',
  ELECTRICITY: 'ELECTRICITY',
  PUBLIC_SPACE: 'PARKS',
  OTHER: null,
};

export async function recommendDepartment(category: IncidentCategory, confidence: number): Promise<DepartmentRecommendation> {
  const code = departmentCodes[category];
  if (!code || confidence < 0.35) return { id: null, name: null, confidence: 0 };
  const department = await prisma.department.findFirst({ where: { code, status: 'ACTIVE' }, select: { id: true, name: true } });
  return department ? { ...department, confidence: Math.min(confidence, 0.95) } : { id: null, name: null, confidence: 0 };
}
