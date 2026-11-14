import type {
  BackupSnapshotList,
  TeacherApiTokenData,
  TeacherApiTokenResetData,
} from "@tutor/contract";
export interface AccountSettingsPorts {
  fetchBackupSnapshots(): Promise<BackupSnapshotList>;
  fetchApiToken(): Promise<TeacherApiTokenData>;
  resetApiToken(): Promise<TeacherApiTokenResetData>;
}
