import { useQueryClient } from "@tanstack/react-query";
import type { StudentMeData, TeacherInfo } from "@tutor/contract";
import { useCallback, useEffect, useRef } from "react";
import {
  currentAnnotationSession,
  resetAnnotationSession,
} from "@/features/annotation/annotation-sync";
import { bindGroupMaterialLayoutAccount } from "@/features/attempt/group-material-layout-store";
import { bindPracticePreferenceAccount } from "@/features/attempt/practice-preference-store";
import { bindKeyboardBindingsAccount } from "@/features/keyboard/keyboard-binding-store";
import {
  currentNoteSession,
  resetNoteSession,
} from "@/features/notes/note-sync";
import { bindDraftSession } from "@/features/persistence/draft-store";
import { usePortalRuntime } from "@/features/runtime/portal-runtime";
import { bindAiDisplayAccount } from "@/features/student-ai/ai-display-preference-store";
import { clearAccountQueries } from "./account-query-cache";
import {
  AuthCancelledError,
  type AuthOperation,
  type AuthRole,
  createAuthOperation,
} from "./auth-operation";
export const teacherStatusKey = ["teacher", "status"] as const;
export interface AuthValues {
  student?: StudentMeData;
  teacher?: TeacherInfo;
}
export const authRoles = (values: AuthValues): AuthRole[] => [
  ...(values.student ? ["student" as const] : []),
  ...(values.teacher ? ["teacher" as const] : []),
];
/** 操作凭据与组件同寿命；下一次意图或卸载关闭旧凭据，绝不重绑旧端口。 */
export function useAuthOperationOwner() {
  const owned = useRef<AuthOperation | null>(null);
  useEffect(() => () => owned.current?.finish(), []);
  return useCallback((operation: AuthOperation) => {
    if (owned.current !== operation) owned.current?.finish();
    owned.current = operation;
    return operation;
  }, []);
}
export function useApplyIdentity() {
  const cache = useQueryClient();
  const own = useAuthOperationOwner();
  const { prefetchStudentAfterAuth } = usePortalRuntime();
  return useCallback(
    async (
      values: AuthValues,
      before: () => boolean = () => true,
      supplied?: AuthOperation,
    ) => {
      const operation = own(supplied ?? createAuthOperation(cache));
      const roles = authRoles(values);
      operation.select(roles);
      const check = () => {
        operation.assertCurrent();
        if (!before()) throw new AuthCancelledError();
      };
      try {
        await Promise.all(
          roles.map((role) =>
            clearAccountQueries(
              cache,
              role,
              () => operation.isCurrent() && before(),
            ),
          ),
        );
        check();
        const student = values.student;
        if (student) {
          if (currentNoteSession()?.studentId !== student.id) {
            check();
            resetNoteSession();
          }
          if (currentAnnotationSession()?.studentId !== student.id) {
            check();
            resetAnnotationSession();
          }
          for (const bind of [
            bindAiDisplayAccount,
            bindPracticePreferenceAccount,
            bindKeyboardBindingsAccount,
            bindGroupMaterialLayoutAccount,
          ]) {
            check();
            bind(student.id);
          }
          check();
          bindDraftSession({
            origin: window.location.origin,
            studentId: student.id,
          });
        }
        for (const role of roles) {
          check();
          operation.commit(role, () =>
            cache.setQueryData([role, "me"], values[role]),
          );
        }
        operation.assertCurrent();
        if (student) prefetchStudentAfterAuth(student, cache);
        operation.assertCurrent();
        if (values.teacher)
          void cache.invalidateQueries({ queryKey: teacherStatusKey });
        operation.assertCurrent();
        return operation;
      } catch (error) {
        operation.finish();
        throw error;
      }
    },
    [cache, own, prefetchStudentAfterAuth],
  );
}
