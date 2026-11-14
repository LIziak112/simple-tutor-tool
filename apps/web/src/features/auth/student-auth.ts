import { useQuery } from "@tanstack/react-query";
import type { StudentLoginRequest, StudentMeData } from "@tutor/contract";
import { useCallback } from "react";
import { usePortalClients } from "@/features/runtime/portal-runtime";
import { useApplyIdentity } from "./auth-apply";
import { useClearIdentitySessions } from "./auth-clear";
import { useAccountMutation } from "./auth-mutation";
import type { AuthOperation } from "./auth-operation";

/**
 * 学生登录状态（T2.3 学生端外壳）：与 teacher-auth 同构的模式——
 * - useStudentMe：路由守卫（/s/* 布局与登录页「已登录直接跳走」）；
 * - useStudentLinkLogin / useLoginStudent：两种登录（§5.7），成功后写入 me 缓存，
 *   避免进入首页后守卫再闪一次 loading；
 * - useLogoutStudent：退出（删除服务端会话 + 清全部学生端查询缓存）。
 */

export const studentMeKey = ["student", "me"] as const;

/** 当前登录学生（未登录时 isError 且错误码 UNAUTHORIZED，由守卫处理跳转） */
export function useStudentMe() {
  const { fetchStudentMe } = usePortalClients();

  return useQuery({
    queryKey: studentMeKey,
    queryFn: fetchStudentMe,
    // 401 不重试：守卫需要立刻感知并跳登录页
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 返回本次可持续验证的身份凭据，取消以AuthCancelledError传播。 */
export function useApplyStudentAuthed() {
  const apply = useApplyIdentity();
  return useCallback(
    (
      student: StudentMeData,
      ownsEntry: () => boolean = () => true,
      operation?: AuthOperation,
    ) => apply({ student }, ownsEntry, operation),
    [apply],
  );
}
export function useStudentLinkLogin() {
  const { loginStudentByLinkApi } = usePortalClients();
  const apply = useApplyIdentity();
  return useAccountMutation(
    (token: string) => loginStudentByLinkApi(token),
    (student, operation) => apply({ student }, undefined, operation),
    ["student"],
  );
}
export function useLoginStudent() {
  const { loginStudentApi } = usePortalClients();
  const apply = useApplyIdentity();
  return useAccountMutation(
    (request: StudentLoginRequest) => loginStudentApi(request),
    (student, operation) => apply({ student }, undefined, operation),
    ["student"],
  );
}
export function useLogoutStudent(onLoggedOut?: () => void) {
  const { logoutStudentApi } = usePortalClients();
  const clear = useClearIdentitySessions();
  return useAccountMutation(
    () => logoutStudentApi(),
    (_data, operation) => clear(["student"], onLoggedOut, operation),
    ["student"],
  );
}
export function useClearStudentSession() {
  const clear = useClearIdentitySessions();
  return useCallback(
    (onCleared?: () => void, expectedId?: string, before?: () => boolean) =>
      clear(
        ["student"],
        onCleared,
        undefined,
        expectedId ? { role: "student", id: expectedId } : undefined,
        before,
      ),
    [clear],
  );
}
