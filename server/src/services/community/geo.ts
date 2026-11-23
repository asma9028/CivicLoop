const earthRadiusMeters = 6_371_000;

const radians = (degrees: number) => degrees * Math.PI / 180;

export function isValidCoordinate(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180;
}

export function distanceMeters(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
) {
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function areaBounds(latitude: number, longitude: number, radiusMeters: number) {
  const latitudeDelta = radiusMeters / 110_574;
  const longitudeFactor = Math.max(Math.cos(radians(latitude)), 0.00001);
  const longitudeDelta = Math.min(180, radiusMeters / (111_320 * longitudeFactor));
  const minLatitude = Math.max(-90, latitude - latitudeDelta);
  const maxLatitude = Math.min(90, latitude + latitudeDelta);
  const minLongitude = longitude - longitudeDelta;
  const maxLongitude = longitude + longitudeDelta;
  const longitudeRanges = minLongitude < -180
    ? [{ min: -180, max: maxLongitude }, { min: minLongitude + 360, max: 180 }]
    : maxLongitude > 180
      ? [{ min: minLongitude, max: 180 }, { min: -180, max: maxLongitude - 360 }]
      : [{ min: minLongitude, max: maxLongitude }];
  return { minLatitude, maxLatitude, longitudeRanges };
}
