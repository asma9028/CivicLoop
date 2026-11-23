import { describe, expect, it } from 'vitest';
import { sanitizePublicText, serializePublicIncident } from './public-incident.js';

describe('public incident privacy serialization', () => {
  it('redacts contact details, street addresses, and precise coordinates from public text', () => {
    const text = sanitizePublicText(
      'Call +1 (555) 123-4567 or email citizen@example.com at 44 Cedar Avenue; coordinates 28.613900, 77.209000.',
    );

    expect(text).not.toContain('555');
    expect(text).not.toContain('citizen@example.com');
    expect(text).not.toContain('44 Cedar Avenue');
    expect(text).not.toContain('28.613900');
    expect(text).toContain('[contact details removed]');
    expect(text).toContain('[address removed]');
  });

  it('provides approximate map coordinates and never returns the submitted location text', () => {
    const result = serializePublicIncident({
      title: 'Pothole near 44 Cedar Avenue',
      description: 'A deep pothole blocks the lane and is a risk for cyclists.',
      summary: 'Issue at 28.613900, 77.209000',
      category: 'ROAD',
      subcategory: null,
      latitude: 28.6139,
      longitude: 77.209,
    });

    expect(result.latitude).toBe(28.61);
    expect(result.longitude).toBe(77.21);
    expect(result.locationText).toBe('Approximate area');
    expect(JSON.stringify(result)).not.toContain('44 Cedar Avenue');
    expect(JSON.stringify(result)).not.toContain('28.613900');
  });

  it('sanitizes common identity, vehicle, and URL tracking data from public text', () => {
    const result = serializePublicIncident({
      title: 'Pothole at 44 Cedar Avenue; plate DL 3C AB 1234',
      description: 'Contact citizen@example.com. Aadhaar 1234 5678 9012. Details: https://example.org/case?utm_source=mail&view=public',
      category: 'ROAD',
      latitude: 28.6139,
      longitude: 77.209,
    });

    expect(result.title).not.toContain('44 Cedar Avenue');
    expect(result.title).not.toContain('DL 3C AB 1234');
    expect(result.description).not.toContain('citizen@example.com');
    expect(result.description).not.toContain('1234 5678 9012');
    expect(result.description).not.toContain('utm_source');
    expect(result.title).toContain('Pothole');
    expect(result.description).toContain('view=public');
    expect(JSON.stringify(result)).not.toContain('reporterId');
  });
});
