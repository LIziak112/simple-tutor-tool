import { useQuery } from "@tanstack/react-query";
import type { PersonalSessionData, TeacherInfo } from "@tutor/contract";
import { useCallback } from "react";
import { usePortalClients } from "@/features/runtime/portal-runtime";
import { teacherStatusKey, useApplyIdentity } from "./auth-apply";
import { useClearIdentitySessions } from "./auth-clear";
import { useAccountMutation } from "./auth-mutation";
import type { AuthOperation } from "./auth-operation";

export { teacherStatusKey } from "./auth-apply";

/**
 * 教师登录状态（T1.9）：TanStack Query 管服务端状态的既有模式——
 * - useTeacherStatus：是否已设置教师（/t/setup 与 /t/login 分流）；
 * - useTeacherMe：当前会话（路由守卫）；
 * - useSetupTeacher / useLoginTeacher / useRegisterTeacher（T2B.6）/ useLogoutTeacher：
 *   写操作，成功后同步 me 缓存，避免登录后守卫再闪一次 loading。
 */

export const teacherMeKey = ["teacher", "me"] as const;

/** 是否已设置教师（公开接口，无需登录） */
export function useTeacherStatus() {
  const { fetchTeacherStatus } = usePortalClients();

  return useQuery({
    queryKey: teacherStatusKey,
    queryFn: fetchTeacherStatus,
    // 首启判断要求相对新鲜；停留期间教师被设置的情况少见但存在（另一设备）
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 当前登录教师（未登录时 isError 且错误码 UNAUTHORIZED，由守卫处理跳转） */
export function useTeacherMe({ freshOnMount = false } = {}) {
  const { fetchTeacherMe } = usePortalClients();

  return useQuery({
    queryKey: teacherMeKey,
    queryFn: fetchTeacherMe,
    // 401 不重试：守卫需要立刻感知并跳登录页
    retry: false,
    staleTime: freshOnMount ? 0 : 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 教师和个人管理半边使用同一同步事务，绝不忽略clear取消。 */
export function useApplyTeacherAuthed() {
  const apply = useApplyIdentity();
  return useCallback((teacher: TeacherInfo) => apply({ teacher }), [apply]);
}
export function useApplyPersonalAuthed() {
  const apply = useApplyIdentity();
  return useCallback(
    (session: PersonalSessionData, operation?: AuthOperation) =>
      apply(session, undefined, operation),
    [apply],
  );
}
export function useSetupTeacher() {
  const { setupTeacher } = usePortalClients();
  const apply = useApplyIdentity();
  return useAccountMutation(
    setupTeacher,
    (teacher, operation) => apply({ teacher }, undefined, operation),
    ["teacher"],
  );
}
export function useLoginTeacher() {
  const { loginTeacher } = usePortalClients();
  const apply = useApplyIdentity();
  return useAccountMutation(
    loginTeacher,
    ({ student, ...teacher }, operation) =>
      apply(student ? { student, teacher } : { teacher }, undefined, operation),
    ["teacher"],
  );
}
export function useRegisterTeacher() {
  const { registerTeacher } = usePortalClients();
  const apply = useApplyIdentity();
  return useAccountMutation(
    registerTeacher,
    (teacher, operation) => apply({ teacher }, undefined, operation),
    ["teacher"],
  );
}
export function useLogoutTeacher(onLoggedOut?: () => void) {
  const { logoutTeacher } = usePortalClients();
  const clear = useClearIdentitySessions();
  return useAccountMutation(
    () => logoutTeacher(),
    (_data, operation) => clear(["teacher"], onLoggedOut, operation),
    ["teacher"],
  );
}
export function useClearTeacherSession() {
  const clear = useClearIdentitySessions();
  return useCallback(
    (onCleared?: () => void, expectedId?: string, before?: () => boolean) =>
      clear(
        ["teacher"],
        onCleared,
        undefined,
        expectedId ? { role: "teacher", id: expectedId } : undefined,
        before,
      ),
    [clear],
  );
}
