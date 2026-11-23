import { IncidentCategory, type Incident } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { roundPublicCoordinate, sanitizePublicText } from '../../utils/public-incident.js';
import type { AnalysisInput, DuplicateMatch } from './types.js';

const stopWords = new Set(['the','and','for','near','with','from','this','that','there','issue','problem','area','reported','has','are']);

export function textSimilarity(first: string, second: string) {
  const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 2 && !stopWords.has(token)) ?? []);
  const left = tokens(first);
  const right = tokens(second);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / (left.size + right.size - intersection);
}

export function geographicDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function findPotentialDuplicates(input: AnalysisInput): Promise<DuplicateMatch[]> {
  const radius = Math.max(50, Math.min(5_000, Number(process.env.INCIDENT_DUPLICATE_RADIUS_METERS) || 300));
  const approximateLocationMargin = 1_000;
  const searchRadius = radius + approximateLocationMargin;
  const days = Math.max(1, Math.min(180, Number(process.env.INCIDENT_DUPLICATE_WINDOW_DAYS) || 30));
  const since = new Date(Date.now() - days * 86_400_000);
  const where: Record<string, unknown> = {
    isPublic: true,
    createdAt: { gte: since },
    status: { notIn: ['REJECTED', 'DUPLICATE'] },
  };
  if (input.latitude !== undefined && input.longitude !== undefined) {
    const latRange = searchRadius / 111_000;
    const lonRange = searchRadius / (111_000 * Math.max(0.1, Math.cos(input.latitude * Math.PI / 180)));
    where.latitude = { gte: input.latitude - latRange, lte: input.latitude + latRange };
    where.longitude = { gte: input.longitude - lonRange, lte: input.longitude + lonRange };
  }
  const candidates = await prisma.incident.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  return candidates.map((incident: Incident) => {
    const approximateDistanceMeters = input.latitude !== undefined && input.longitude !== undefined
      ? geographicDistanceMeters(
        input.latitude,
        input.longitude,
        roundPublicCoordinate(incident.latitude),
        roundPublicCoordinate(incident.longitude),
      )
      : null;
    const categoryScore = incident.category === input.category ? 0.25 : 0;
    const textScore = textSimilarity(`${input.title} ${input.description} ${input.locationText ?? ''}`, `${incident.title} ${incident.description} ${incident.locationText}`);
    const proximityScore = approximateDistanceMeters === null
      ? 0
      : Math.max(0, 1 - approximateDistanceMeters / searchRadius) * 0.35;
    const similarity = Math.min(1, categoryScore + textScore * 0.4 + proximityScore);
    return {
      approximateDistanceMeters,
      match: {
        id: incident.id,
        category: incident.category,
        title: sanitizePublicText(incident.title, 160),
        description: sanitizePublicText(incident.description, 220),
        status: incident.status,
        locationText: 'Approximate area',
        createdAt: incident.createdAt,
        distanceMeters: null,
        distanceLabel: approximateDistanceMeters === null ? 'Distance unavailable' : 'Nearby',
        similarity: Math.round(similarity * 100) / 100,
      },
    };
  }).filter((match) => {
    if (match.approximateDistanceMeters !== null && match.approximateDistanceMeters > searchRadius) return false;
    return match.match.similarity >= (input.latitude === undefined ? 0.3 : 0.38);
  }).sort((a, b) => b.match.similarity - a.match.similarity).slice(0, 5).map(({ match }) => match);
}
