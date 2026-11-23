import { sanitizeSensitiveText } from './privacy-text.js';

export function sanitizePublicText(value: string, maxLength = 500) {
  return sanitizeSensitiveText(value, maxLength);
}

export function roundPublicCoordinate(value: number) {
  return Math.round(value * 100) / 100;
}

export function serializePublicIncident(input: {
  title: string;
  description: string;
  summary?: string | null;
  category: string;
  subcategory?: string | null;
  latitude: number;
  longitude: number;
}) {
  return {
    title: sanitizePublicText(input.title, 160),
    description: sanitizePublicText(input.description, 2_000),
    summary: input.summary ? sanitizePublicText(input.summary, 500) : null,
    category: input.category,
    subcategory: input.subcategory ? sanitizePublicText(input.subcategory, 80) : null,
    locationText: 'Approximate area',
    latitude: roundPublicCoordinate(input.latitude),
    longitude: roundPublicCoordinate(input.longitude),
  };
}
