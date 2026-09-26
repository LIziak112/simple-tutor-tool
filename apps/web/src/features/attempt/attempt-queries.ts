import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudentAnswer } from "@tutor/contract";
import { studentAssignmentsKey } from "@/features/student/student-queries";
import {
  fetchAttemptApi,
  saveAttemptAnswerApi,
  startAttemptApi,
  submitAttemptApi,
} from "@/lib/api";

/**
 * 学生端作答数据层（T2.6）：attempt 创建（进入答题页时幂等发起）、
 * 详情查询（草稿/结果二态视图）、草稿保存与交卷 mutation。
 */

/** 单个 attempt 详情 key */
export const studentAttemptKey = (attemptId: string) =>
  ["student", "attempt", attemptId] as const;

/** attempt 详情（draft→草稿视图、submitted/graded→结果视图；按 attempt.status 分支） */
export function useAttemptDetail(attemptId: string | undefined) {
  return useQuery({
    queryKey: studentAttemptKey(attemptId ?? "pending"),
    queryFn: () => fetchAttemptApi(attemptId ?? ""),
    enabled: attemptId !== undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 创建/取回 attempt（进入答题页触发；返回摘要含 status 决定走答题还是结果视图） */
export function useStartAttempt(assignmentId: string) {
  return useMutation({
    mutationFn: () => startAttemptApi(assignmentId),
  });
}

/** 交卷：成功后失效 attempt 详情与作业列表（首页状态徽章联动） */
export function useSubmitAttempt(attemptId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => submitAttemptApi(attemptId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: studentAttemptKey(attemptId),
      });
      void queryClient.invalidateQueries({ queryKey: studentAssignmentsKey });
    },
  });
}

/**
 * 草稿保存的底层调用（useAttemptAnswers 直接调用，不走 useMutation——
 * 高频触发（每次作答/每个防抖窗）时 mutation 栈会堆积无意义的历史条目）。
 * 失败由调用方捕获并置「保存失败」提示；重试靠学生继续作答或刷新页面。
 */
export function saveDraftAnswer(
  attemptId: string,
  questionId: string,
  answer: StudentAnswer,
): Promise<unknown> {
  return saveAttemptAnswerApi(attemptId, questionId, answer);
}
