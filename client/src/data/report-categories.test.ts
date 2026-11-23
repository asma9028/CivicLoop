import { describe, expect, it } from 'vitest';
import { reportCategories } from './report-categories';

describe('citizen report categories', () => {
  it('uses unique backend-compatible categories and routes generic infrastructure to Other', () => {
    const ids = reportCategories.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(reportCategories.find((category) => category.label.includes('Public Infrastructure'))?.id).toBe('OTHER');
  });
});
