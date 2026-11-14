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
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createAdministrationClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchAdminTeachers(
    status: "all" | "active" | "disabled",
  ): Promise<AdminTeacherListData> {
    // status=all 时也显式传参（契约默认同值，保持请求形状稳定便于缓存键区分）
    return callApi(() => api.api.admin.teachers.$get({ query: { status } }));
  }
  function createAdminTeacherApi(
    request: AdminTeacherCreateRequest,
  ): Promise<AdminTeacherCreateData> {
    return callApi(() => api.api.admin.teachers.$post({ json: request }));
  }
  function updateAdminTeacherApi(
    id: string,
    request: AdminTeacherUpdateRequest,
  ): Promise<AdminTeacherSummary> {
    const args = { param: { id }, json: request };
    return callApi(() => api.api.admin.teachers[":id"].$patch(args));
  }
  function disableAdminTeacherApi(id: string): Promise<AdminTeacherSummary> {
    return callApi(() =>
      api.api.admin.teachers[":id"].disable.$post({ param: { id } }),
    );
  }
  function enableAdminTeacherApi(id: string): Promise<AdminTeacherSummary> {
    return callApi(() =>
      api.api.admin.teachers[":id"].enable.$post({ param: { id } }),
    );
  }
  function resetAdminTeacherPasswordApi(
    id: string,
    request: AdminTeacherResetPasswordRequest,
  ): Promise<AdminTeacherResetPasswordData> {
    const args = { param: { id }, json: request };
    return callApi(() =>
      api.api.admin.teachers[":id"]["reset-password"].$post(args),
    );
  }
  function fetchAdminSettings(): Promise<AdminSettingsData> {
    return callApi(() => api.api.admin.settings.$get());
  }
  function updateAdminSettingsApi(
    request: AdminSettingsUpdateRequest,
  ): Promise<AdminSettingsData> {
    return callApi(() => api.api.admin.settings.$patch({ json: request }));
  }
  function fetchAdminOverview(): Promise<AdminOverviewData> {
    return callApi(() => api.api.admin.overview.$get());
  }
  return {
    fetchAdminTeachers,
    createAdminTeacherApi,
    updateAdminTeacherApi,
    disableAdminTeacherApi,
    enableAdminTeacherApi,
    resetAdminTeacherPasswordApi,
    fetchAdminSettings,
    updateAdminSettingsApi,
    fetchAdminOverview,
  };
}
