import { describe, expect, it } from 'vitest';
import { hasActiveAuthorityDepartment } from './authorization.js';

describe('private authority department access', () => {
  it('requires an active matching department', () => {
    expect(hasActiveAuthorityDepartment(
      { departmentId: 'roads', department: { status: 'ACTIVE' } },
      'roads',
    )).toBe(true);
    expect(hasActiveAuthorityDepartment(
      { departmentId: 'roads', department: { status: 'INACTIVE' } },
      'roads',
    )).toBe(false);
    expect(hasActiveAuthorityDepartment(
      { departmentId: 'roads', department: { status: 'ACTIVE' } },
      'water',
    )).toBe(false);
    expect(hasActiveAuthorityDepartment(null, 'roads')).toBe(false);
  });
});
