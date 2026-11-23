export function validateRuntimeConfiguration(environment: NodeJS.ProcessEnv) {
  if (environment.NODE_ENV === 'production' && !environment.JWT_SECRET?.trim()) {
    throw new Error('JWT_SECRET must be configured before starting CivicLoop in production.');
  }
}
