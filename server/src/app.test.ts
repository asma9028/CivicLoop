import { describe, expect, it } from 'vitest';
import { app } from './app.js';

describe('Express proxy configuration', () => {
  it('trusts exactly one proxy hop for client IP handling', () => {
    const trustProxy = app.get('trust proxy fn') as (address: string, hop: number) => boolean;

    expect(app.get('trust proxy')).toBe(1);
    expect(trustProxy('198.51.100.10', 0)).toBe(true);
    expect(trustProxy('198.51.100.11', 1)).toBe(false);
  });
});
