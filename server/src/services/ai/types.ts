import type { IncidentCategory, Severity } from '@prisma/client';

export interface AnalysisInput {
  title: string;
  description: string;
  category?: IncidentCategory;
  locationText?: string;
  latitude?: number;
  longitude?: number;
}

export interface Classification {
  category: IncidentCategory;
  subcategory: string;
  summary: string;
  severity: Severity;
  confidence: number;
  reasoning: string;
  safetyRisk: number;
  publicImpact: number;
  timeSensitivity: number;
  source: 'gemini' | 'rules';
}

export interface DepartmentRecommendation {
  id: string | null;
  name: string | null;
  confidence: number;
}

export interface DuplicateMatch {
  id: string;
  category: IncidentCategory;
  title: string;
  description: string;
  status: string;
  locationText: string;
  createdAt: Date;
  distanceMeters: null;
  distanceLabel: string;
  similarity: number;
}
