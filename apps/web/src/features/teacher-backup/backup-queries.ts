import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BACKUP_OPERATOR_REQUIRED, type TeacherInfo } from "@tutor/contract";
import { teacherMeKey } from "@/features/auth/teacher-auth";
import {
  ApiError,
  downloadBackupApi,
  fetchBackupSnapshots,
  restoreBackupApi,
} from "@/lib/api";

/**
 * 备份与恢复的查询封装（T4.5，纯消费接口；设置页「备份与恢复」区数据源）：
 * - 快照列表：useQuery（快照只在服务端调度时变化，窗口聚焦不自动重取）；
 * - 下载 / 恢复：useMutation（一次性动作，恢复成功后使快照列表失效重取）。
 */

/** 快照列表查询键（恢复成功后失效重取） */
export const backupSnapshotsKey = ["teacher", "backup", "snapshots"] as const;

function useUpdateBackupAccessOnDenial() {
  const queryClient = useQueryClient();
  return async <T>(run: () => Promise<T>): Promise<T> => {
    const teacherId = queryClient.getQueryData<TeacherInfo>(teacherMeKey)?.id;
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === BACKUP_OPERATOR_REQUIRED
      ) {
        queryClient.setQueryData<TeacherInfo>(teacherMeKey, (teacher) =>
          teacher && teacher.id === teacherId
            ? { ...teacher, canManageInstanceBackup: false }
            : teacher,
        );
      }
      throw error;
    }
  };
}

/** 最近快照列表（设置页展示时间 + 大小 + 文件名） */
export function useBackupSnapshots() {
  const updateAccessOnDenial = useUpdateBackupAccessOnDenial();
  return useQuery({
    queryKey: backupSnapshotsKey,
    queryFn: () => updateAccessOnDenial(fetchBackupSnapshots),
    refetchOnWindowFocus: false,
  });
}

/** 下载完整备份 zip（返回下载文件名供页面展示） */
export function useDownloadBackup() {
  const updateAccessOnDenial = useUpdateBackupAccessOnDenial();
  return useMutation({
    mutationFn: () => updateAccessOnDenial(downloadBackupApi),
  });
}

/** 从备份 zip 恢复整库（multipart zip + 登录密码；返回恢复摘要） */
export function useRestoreBackup() {
  const queryClient = useQueryClient();
  const updateAccessOnDenial = useUpdateBackupAccessOnDenial();
  return useMutation({
    mutationFn: (input: { zip: File; password: string }) =>
      updateAccessOnDenial(() => restoreBackupApi(input.zip, input.password)),
    onSuccess: () => {
      // 恢复替换整库：快照列表（恢复前自动快照）需要重取
      void queryClient.invalidateQueries({ queryKey: backupSnapshotsKey });
    },
  });
}
