import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PersonalSessionData, TeacherInfo } from "@tutor/contract";
import {
  fetchTeacherMe,
  fetchTeacherStatus,
  loginTeacher,
  logoutTeacher,
  registerTeacher,
  setupTeacher,
} from "@/lib/api";
import { clearAccountQueries } from "./account-query-cache";
import { useApplyStudentAuthed } from "./student-auth";

/**
 * 教师登录状态（T1.9）：TanStack Query 管服务端状态的既有模式——
 * - useTeacherStatus：是否已设置教师（/t/setup 与 /t/login 分流）；
 * - useTeacherMe：当前会话（路由守卫）；
 * - useSetupTeacher / useLoginTeacher / useRegisterTeacher（T2B.6）/ useLogoutTeacher：
 *   写操作，成功后同步 me 缓存，避免登录后守卫再闪一次 loading。
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

/**
 * 登录/设置成功后写入 me 缓存并刷新 status（首启 → 已设置）。
 * 导出供个人账号双会话登录复用（personal-auth.ts，模块 0）。
 */
export function useApplyTeacherAuthed() {
  const queryClient = useQueryClient();
  return async (teacher: TeacherInfo) => {
    await clearAccountQueries(queryClient, "teacher");
    queryClient.setQueryData(teacherMeKey, teacher);
    void queryClient.invalidateQueries({ queryKey: teacherStatusKey });
  };
}

export function useApplyPersonalAuthed() {
  const applyTeacher = useApplyTeacherAuthed();
  const applyStudent = useApplyStudentAuthed();
  return async ({ teacher, student }: PersonalSessionData) => {
    await Promise.all([applyStudent(student), applyTeacher(teacher)]);
  };
}

/** 首次设置密码（成功自动登录） */
export function useSetupTeacher() {
  const applyAuthed = useApplyTeacherAuthed();
  return useMutation({
    mutationFn: setupTeacher,
    onSuccess: applyAuthed,
  });
}

/** 密码登录 */
export function useLoginTeacher() {
  const applyAuthed = useApplyTeacherAuthed();
  const applyPersonal = useApplyPersonalAuthed();
  return useMutation({
    mutationFn: loginTeacher,
    onSuccess: ({ student, ...teacher }) =>
      student === undefined
        ? applyAuthed(teacher)
        : applyPersonal({ teacher, student }),
  });
}

/** 自助注册（T2B.6，D3：成功即自动登录，缓存同步与登录一致） */
export function useRegisterTeacher() {
  const applyAuthed = useApplyTeacherAuthed();
  return useMutation({
    mutationFn: registerTeacher,
    onSuccess: applyAuthed,
  });
}

/** 退出登录：清理教师及管理数据并重置身份，学生会话继续保留。 */
export function useLogoutTeacher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logoutTeacher,
    onSuccess: async () => {
      await clearAccountQueries(queryClient, "teacher");
      await queryClient.resetQueries({ queryKey: teacherMeKey, exact: true });
    },
  });
}
