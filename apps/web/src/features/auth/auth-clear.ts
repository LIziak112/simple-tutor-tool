import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { resetAnnotationSession } from "@/features/annotation/annotation-sync";
import { bindGroupMaterialLayoutAccount } from "@/features/attempt/group-material-layout-store";
import { bindPracticePreferenceAccount } from "@/features/attempt/practice-preference-store";
import { bindKeyboardBindingsAccount } from "@/features/keyboard/keyboard-binding-store";
import { resetNoteSession } from "@/features/notes/note-sync";
import { bindDraftSession } from "@/features/persistence/draft-store";
import { bindAiDisplayAccount } from "@/features/student-ai/ai-display-preference-store";
import { clearAccountQueries } from "./account-query-cache";
import { useAuthOperationOwner } from "./auth-apply";
import {
  AuthCancelledError,
  type AuthOperation,
  type AuthRole,
  createAuthOperation,
} from "./auth-operation";
export function useClearIdentitySessions() {
  const cache = useQueryClient();
  const own = useAuthOperationOwner();
  return useCallback(
    async (
      roles: readonly AuthRole[],
      onCleared?: () => void,
      supplied?: AuthOperation,
      expected?: { role: AuthRole; id: string },
      before: () => boolean = () => true,
    ) => {
      const operation = own(supplied ?? createAuthOperation(cache));
      operation.select(roles);
      const check = () => {
        operation.assertCurrent();
        if (!before()) throw new AuthCancelledError();
      };
      try {
        check();
        if (
          expected &&
          cache.getQueryData<{ id: string }>([expected.role, "me"])?.id !==
            expected.id
        )
          throw new AuthCancelledError();
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
        if (roles.includes("student")) {
          for (const clear of [
            () => bindDraftSession(null),
            () => bindAiDisplayAccount(null),
            () => bindPracticePreferenceAccount(null),
            () => bindKeyboardBindingsAccount(null),
            () => bindGroupMaterialLayoutAccount(null),
            resetNoteSession,
            resetAnnotationSession,
          ]) {
            check();
            clear();
          }
        }
        const resets: Promise<void>[] = [];
        check();
        for (const role of roles)
          operation.commit(
            role,
            () => {
              resets.push(
                cache.resetQueries({ queryKey: [role, "me"], exact: true }),
              );
            },
            true,
          );
        operation.assertCurrent();
        if (onCleared) operation.consume(onCleared);
        await Promise.all(resets);
        if (!operation.consumed) operation.assertCurrent();
        return operation;
      } catch (error) {
        operation.finish();
        throw error;
      }
    },
    [cache, own],
  );
}
