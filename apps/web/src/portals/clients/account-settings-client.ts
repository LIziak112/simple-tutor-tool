import type {
  BackupSnapshotList,
  TeacherApiTokenData,
  TeacherApiTokenResetData,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
import type { ClientServices } from "./service-types";
export function createAccountSettingsClient(
  http: HttpRuntime,
  _deps: () => ClientServices,
) {
  const { api } = http;
  function fetchBackupSnapshots(): Promise<BackupSnapshotList> {
    return callApi(() => api.api.teacher.backup.snapshots.$get());
  }
  function fetchApiToken(): Promise<TeacherApiTokenData> {
    return callApi(() => api.api.teacher["api-token"].$get());
  }
  function resetApiToken(): Promise<TeacherApiTokenResetData> {
    return callApi(() => api.api.teacher["api-token"].$post());
  }
  return { fetchBackupSnapshots, fetchApiToken, resetApiToken };
}
