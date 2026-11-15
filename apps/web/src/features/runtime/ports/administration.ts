import type {
  AdminOverviewData,
  AdminSettingsData,
  AdminSettingsUpdateRequest,
  AdminTeacherCreateData,
  AdminTeacherCreateRequest,
  AdminTeacherListData,
  AdminTeacherResetPasswordData,
  AdminTeacherResetPasswordRequest,
  AdminTeacherSummary,
  AdminTeacherUpdateRequest,
} from "@tutor/contract";
export interface AdministrationPorts {
  fetchAdminTeachers(
    status: "all" | "active" | "disabled",
  ): Promise<AdminTeacherListData>;
  createAdminTeacherApi(
    request: AdminTeacherCreateRequest,
  ): Promise<AdminTeacherCreateData>;
  updateAdminTeacherApi(
    id: string,
    request: AdminTeacherUpdateRequest,
  ): Promise<AdminTeacherSummary>;
  disableAdminTeacherApi(id: string): Promise<AdminTeacherSummary>;
  enableAdminTeacherApi(id: string): Promise<AdminTeacherSummary>;
  resetAdminTeacherPasswordApi(
    id: string,
    request: AdminTeacherResetPasswordRequest,
  ): Promise<AdminTeacherResetPasswordData>;
  fetchAdminSettings(): Promise<AdminSettingsData>;
  updateAdminSettingsApi(
    request: AdminSettingsUpdateRequest,
  ): Promise<AdminSettingsData>;
  fetchAdminOverview(): Promise<AdminOverviewData>;
}
