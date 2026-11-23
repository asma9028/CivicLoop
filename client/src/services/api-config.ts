export function resolveApiBaseUrl(configuredOrigin: string | undefined) {
  const value = configuredOrigin?.trim();
  if (!value) return '';

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('VITE_API_URL must be an absolute HTTP or HTTPS origin.');
  }

  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error('VITE_API_URL must use HTTP or HTTPS.');
  }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('VITE_API_URL must contain only the API origin, without credentials, a path, query, or fragment.');
  }

  return origin.origin;
}
