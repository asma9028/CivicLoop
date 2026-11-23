import { describe, expect, it } from 'vitest';
import { validateRuntimeConfiguration } from './runtime.js';

describe('runtime configuration', () => {
  it('allows local development without production-only configuration', () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('fails fast when production auth has no signing secret', () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET must be configured/);
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'production', JWT_SECRET: '   ' })).toThrow(/JWT_SECRET must be configured/);
  });

  it('accepts a configured production signing secret', () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'production', JWT_SECRET: 'configured-by-secret-manager' })).not.toThrow();
  });
});
