import { resolveApiBaseUrl } from './api-config';

export const apiBaseUrl = resolveApiBaseUrl(import.meta.env.VITE_API_URL);

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: options.body instanceof FormData
      ? options.headers
      : { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json().catch(() => ({
    error: 'Unexpected server response. Check the API origin and the same-origin /api proxy configuration.',
  }));
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body as T;
}

export function apiUrl(path: string) {
  return `${apiBaseUrl}${path}`;
}

export interface PublicIncident {
  id: string;
  title: string;
  description: string;
  summary?: string | null;
  category: Category;
  subcategory?: string | null;
  locationText: string;
  latitude: number;
  longitude: number;
  status: string;
  severity?: string;
  priorityScore: number;
  priorityBand: string;
  imageUrls: string[];
  createdAt: string;
  department?: { id: string; name: string; code?: string } | null;
  verificationStatus?: 'UNDER_REVIEW' | 'PENDING';
  verification?: {
    status: 'VERIFIED';
    verifiedAt: string;
    method: string;
    resolutionSummary: string;
    workCompleted: string | null;
    resolutionDate: string | null;
    evidenceImageUrls: string[];
  };
  duplicateOf?: { id: string; title: string; status: string } | null;
  activities?: {
    id: string;
    activityType: string;
    activityDescription: string;
    previousStatus: string | null;
    newStatus: string | null;
    createdAt: string;
    actor: { fullName: string } | null;
  }[];
}

import type { Category } from '../types';
