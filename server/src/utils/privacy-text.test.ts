import { describe, expect, it } from 'vitest';
import { sanitizeSensitiveText } from './privacy-text.js';

describe('best-effort sensitive text filtering', () => {
  it('masks common contact details, identity numbers, coordinates, addresses, and vehicle registrations', () => {
    const result = sanitizeSensitiveText(
      'Pothole at 44 Cedar Avenue. Email citizen@example.com or call +91 98765 43210. Aadhaar 1234 5678 9012; PAN ABCDE1234F; plate DL 3C AB 1234; coordinates 28.613900, 77.209000.',
    );

    expect(result).toContain('Pothole');
    expect(result).toContain('[address removed]');
    expect(result).toContain('[contact details removed]');
    expect(result).toContain('[identification number removed]');
    expect(result).toContain('[vehicle identifier removed]');
    expect(result).toContain('[location removed]');
    expect(result).not.toContain('citizen@example.com');
    expect(result).not.toContain('98765');
    expect(result).not.toContain('1234 5678 9012');
    expect(result).not.toContain('ABCDE1234F');
    expect(result).not.toContain('DL 3C AB 1234');
    expect(result).not.toContain('28.613900');
  });

  it('removes obvious identifying and tracking URL parameters while preserving useful civic context', () => {
    const result = sanitizeSensitiveText(
      'See https://example.org/report?utm_source=email&fbclid=tracking-token&view=public for the city notice.',
    );

    expect(result).toContain('https://example.org/report?view=public');
    expect(result).not.toContain('utm_source');
    expect(result).not.toContain('tracking-token');
    expect(result).toContain('city notice');
  });

  it('masks labeled passwords, authorization headers, session cookies, and token formats', () => {
    const result = sanitizeSensitiveText(
      'Pothole report. password is secret-value; Authorization: Bearer abc.def-123; Cookie: session_id=synthetic-cookie; jwt eyJabcdefghijk.abcdefghijk.abcdefghijk; key AIza123456789012345678901234567890123456',
    );

    expect(result).toContain('Pothole report');
    expect(result).not.toContain('secret-value');
    expect(result).not.toContain('abc.def-123');
    expect(result).not.toContain('synthetic-cookie');
    expect(result).not.toContain('eyJabcdefghijk');
    expect(result).not.toContain('AIza1234567890');
    expect(result).toContain('[credential removed]');
  });

  it('respects the requested output limit', () => {
    expect(sanitizeSensitiveText('A long civic report', 6)).toBe('A long');
  });
});
