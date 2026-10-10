import { useCallback, useMemo, useState } from "react";
import { useAnnotationSessionRef } from "@/features/annotation/use-annotation-record";

/** 待检查标记仅保存在本机，按部署、学生和练习隔离。 */
export function useWorkspaceFlags(attemptId: string) {
  const session = useAnnotationSessionRef();
  const key =
    session === null
      ? null
      : `attempt-flags:${JSON.stringify([session.origin, session.studentId, attemptId])}`;
  const stored = useMemo<ReadonlySet<string>>(() => {
    if (key === null) return new Set();
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((value): value is string => typeof value === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  }, [key]);
  const [edited, setEdited] = useState<{
    key: string | null;
    flags: ReadonlySet<string>;
  } | null>(null);
  const flags = edited?.key === key ? edited.flags : stored;
  const toggle = useCallback(
    (questionId: string) => {
      const next = new Set(flags);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      setEdited({ key, flags: next });
      if (key !== null) {
        try {
          localStorage.setItem(key, JSON.stringify([...next]));
        } catch {
          // 存储不可用时保留本次会话状态，标记不影响答案提交。
        }
      }
    },
    [flags, key],
  );
  return { flags, toggle };
}
