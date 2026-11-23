export function hasActiveAuthorityDepartment(
  profile: { departmentId: string; department: { status: string } } | null,
  incidentDepartmentId: string | null,
) {
  return Boolean(
    profile
    && profile.department.status === 'ACTIVE'
    && incidentDepartmentId
    && profile.departmentId === incidentDepartmentId,
  );
}
