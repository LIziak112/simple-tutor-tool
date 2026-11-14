import type { AttemptDraftData, AttemptSummary } from "@tutor/contract";
import { useCallback, useState } from "react";
import { usePortalClients } from "@/features/runtime/portal-runtime";

/** 「不会」乐观状态与真实写入凭据一起变化，失败只回滚本次标记。 */
export function useStudentFlags(
  attempt: AttemptSummary,
  initial: AttemptDraftData["studentFlags"],
) {
  const { setStudentFlagApi } = usePortalClients();
  const [studentFlags, setStudentFlags] = useState<ReadonlySet<string>>(
    () => new Set(Object.keys(initial ?? {})),
  );
  const toggleUnsure = useCallback(
    (questionId: string) => {
      const next = new Set(studentFlags);
      const flag = next.has(questionId) ? null : "unsure";
      if (flag === null) next.delete(questionId);
      else next.add(questionId);
      setStudentFlags(next);
      setStudentFlagApi(
        attempt.id,
        questionId,
        flag,
        attempt.frozenAt === undefined
          ? undefined
          : { expectedFrozenAt: attempt.frozenAt },
      ).catch(() => {
        setStudentFlags((previous) => {
          const rollback = new Set(previous);
          if (flag === null) rollback.add(questionId);
          else rollback.delete(questionId);
          return rollback;
        });
      });
    },
    [attempt.id, attempt.frozenAt, studentFlags, setStudentFlagApi],
  );
  return { studentFlags, toggleUnsure };
}
