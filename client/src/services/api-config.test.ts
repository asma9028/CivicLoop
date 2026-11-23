import { describe, expect, it } from 'vitest';
import { resolveApiBaseUrl } from './api-config';

describe('API origin configuration', () => {
  it('uses same-origin API paths when no separate origin is configured', () => {
    expect(resolveApiBaseUrl(undefined)).toBe('');
    expect(resolveApiBaseUrl('  ')).toBe('');
  });

  it('normalizes an explicitly configured remote API origin', () => {
    expect(resolveApiBaseUrl(' https://api.example.test/ ')).toBe('https://api.example.test');
  });

  it('rejects values that are not a plain HTTP(S) origin', () => {
    expect(() => resolveApiBaseUrl('/api')).toThrow(/absolute HTTP or HTTPS origin/);
    expect(() => resolveApiBaseUrl('ftp://api.example.test')).toThrow(/HTTP or HTTPS/);
    expect(() => resolveApiBaseUrl('https://api.example.test/v1')).toThrow(/only the API origin/);
  });
});
