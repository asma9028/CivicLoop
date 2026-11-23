import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyIncident, ruleBasedClassification } from './classifier.js';

const draft = { title: 'Large pothole on main road', description: 'A deep pothole is creating a dangerous hazard for road users.' };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
});

describe('incident classification', () => {
  it('uses the rule-based fallback without an API key', async () => {
    const result = await classifyIncident(draft);
    expect(result.source).toBe('rules');
    expect(result.category).toBe('ROAD');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('falls back safely when the AI provider returns invalid data', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"category":"ADMIN","severity":"CRITICAL"}' }] } }],
    }), { status: 200 })));
    const result = await classifyIncident(draft, { allowExternalAI: true });
    expect(result.source).toBe('rules');
    expect(result.category).toBe('ROAD');
  });

  it('does not contact Gemini unless the caller explicitly opts in', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await classifyIncident(draft);

    expect(result.source).toBe('rules');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends only best-effort sanitized report text to Gemini', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    let requestBody = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      requestBody = String(options.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          category: 'ROAD',
          subcategory: 'pothole',
          summary: 'A pothole blocks the road.',
          severity: 'HIGH',
          confidence: 0.9,
          reasoning: 'The report describes a road hazard.',
          safetyRisk: 80,
          publicImpact: 50,
          timeSensitivity: 75,
        }) }] } }],
      }), { status: 200 });
    }));

    await classifyIncident({
      title: 'Pothole at 44 Cedar Avenue',
      description: 'Contact citizen@example.com at +91 98765 43210. Aadhaar 1234 5678 9012; location 28.613900, 77.209000.',
      category: 'ROAD',
      locationText: '44 Cedar Avenue',
      latitude: 28.6139,
      longitude: 77.209,
    }, { allowExternalAI: true });

    expect(requestBody).not.toContain('citizen@example.com');
    expect(requestBody).not.toContain('+91 98765 43210');
    expect(requestBody).not.toContain('1234 5678 9012');
    expect(requestBody).not.toContain('28.613900');
    expect(requestBody).not.toContain('44 Cedar Avenue');
    expect(requestBody).toContain('[contact details removed]');
    expect(requestBody).toContain('[identification number removed]');
    expect(requestBody).toContain('[location removed]');
  });

  it('sanitizes provider echoes and keeps the local fallback on provider failure', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          category: 'ROAD',
          subcategory: 'citizen@example.com',
          summary: 'Contact citizen@example.com about this pothole.',
          severity: 'MEDIUM',
          confidence: 0.8,
          reasoning: 'Call +91 98765 43210 to review the reported pothole.',
          safetyRisk: 45,
          publicImpact: 30,
          timeSensitivity: 40,
        }) }] } }],
      }), { status: 200 }))
      .mockRejectedValueOnce(new Error('synthetic provider failure'));
    vi.stubGlobal('fetch', fetchMock);

    const echoed = await classifyIncident(draft, { allowExternalAI: true });
    const failed = await classifyIncident({
      ...draft,
      description: 'A pothole is dangerous; contact citizen@example.com.',
    }, { allowExternalAI: true });

    expect(echoed.summary).not.toContain('citizen@example.com');
    expect(echoed.reasoning).not.toContain('98765');
    expect(failed.source).toBe('rules');
    expect(failed.category).toBe('ROAD');
  });

  it('accepts validated structured Gemini recommendations', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const output = {
      category: 'ROAD',
      subcategory: 'pothole',
      summary: 'A pothole creates a road hazard.',
      severity: 'HIGH',
      confidence: 0.99,
      reasoning: 'The report explicitly describes a pothole hazard.',
      safetyRisk: 80,
      publicImpact: 60,
      timeSensitivity: 75,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
    }), { status: 200 })));
    const result = await classifyIncident(draft, { allowExternalAI: true });
    expect(result.source).toBe('gemini');
    expect(result.confidence).toBe(0.95);
  });

  it('produces cautious low-confidence output for unclear text', () => {
    const result = ruleBasedClassification({ title: 'Something seems wrong', description: 'There may be an issue somewhere in the area.' });
    expect(result.category).toBe('OTHER');
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('does not route generic public infrastructure to roads or parks', () => {
    const result = ruleBasedClassification({
      title: 'Public infrastructure damage',
      description: 'A damaged piece of public infrastructure needs assessment.',
    });

    expect(result.category).toBe('OTHER');
  });

  it('keeps generic public infrastructure in the selected existing category despite an AI suggestion', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const output = {
      category: 'ROAD',
      subcategory: 'road',
      summary: 'A public infrastructure issue needs review.',
      severity: 'LOW',
      confidence: 0.9,
      reasoning: 'The general phrase was interpreted as a road issue.',
      safetyRisk: 10,
      publicImpact: 20,
      timeSensitivity: 10,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }],
    }), { status: 200 })));

    const result = await classifyIncident({
      title: 'Public infrastructure damage',
      description: 'A damaged piece of public infrastructure needs assessment.',
      category: 'OTHER',
    }, { allowExternalAI: true });

    expect(result.category).toBe('OTHER');
  });
});
