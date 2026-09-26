import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeacherInfo } from "@tutor/contract";
import {
  fetchTeacherMe,
  fetchTeacherStatus,
  loginTeacher,
  logoutTeacher,
  setupTeacher,
} from "@/lib/api";

/**
 * 教师登录状态（T1.9）：TanStack Query 管服务端状态的既有模式——
 * - useTeacherStatus：是否已设置教师（/t/setup 与 /t/login 分流）；
 * - useTeacherMe：当前会话（路由守卫）；
 * - useSetupTeacher / useLoginTeacher / useLogoutTeacher：写操作，
 *   成功后同步 me 缓存，避免登录后守卫再闪一次 loading。
 */

export const teacherStatusKey = ["teacher", "status"] as const;
export const teacherMeKey = ["teacher", "me"] as const;

/** 是否已设置教师（公开接口，无需登录） */
export function useTeacherStatus() {
  return useQuery({
    queryKey: teacherStatusKey,
    queryFn: fetchTeacherStatus,
    // 首启判断要求相对新鲜；停留期间教师被设置的情况少见但存在（另一设备）
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 当前登录教师（未登录时 isError 且错误码 UNAUTHORIZED，由守卫处理跳转） */
export function useTeacherMe() {
  return useQuery({
    queryKey: teacherMeKey,
    queryFn: fetchTeacherMe,
    // 401 不重试：守卫需要立刻感知并跳登录页
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 登录/设置成功后写入 me 缓存并刷新 status（首启 → 已设置） */
function useApplyAuthed() {
  const queryClient = useQueryClient();
  return (teacher: TeacherInfo) => {
    queryClient.setQueryData(teacherMeKey, teacher);
    void queryClient.invalidateQueries({ queryKey: teacherStatusKey });
  };
}

/** 首次设置密码（成功自动登录） */
export function useSetupTeacher() {
  const applyAuthed = useApplyAuthed();
  return useMutation({
    mutationFn: setupTeacher,
    onSuccess: applyAuthed,
  });
}

/** 密码登录 */
export function useLoginTeacher() {
  const applyAuthed = useApplyAuthed();
  return useMutation({
    mutationFn: loginTeacher,
    onSuccess: applyAuthed,
  });
}

/** 退出登录：成功后清空 me 缓存（守卫随即将 /t/* 导回登录页） */
export function useLogoutTeacher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logoutTeacher,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: teacherMeKey });
    },
  });
}
