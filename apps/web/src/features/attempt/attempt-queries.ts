import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudentAnswer } from "@tutor/contract";
import {
  studentAssignmentsKey,
  studentCoursesKey,
} from "@/features/student/student-queries";
import {
  fetchAttemptApi,
  fetchStudentUnitLandingApi,
  saveAttemptAnswerApi,
  startAttemptApi,
  startCourseAttemptApi,
  submitAttemptApi,
} from "@/lib/api";

/**
 * 学生端作答数据层（T2.6；T2A.6 扩展课程练习）：attempt 创建（作业/课程两种
 * 来源入口）、单元落地查询、详情查询（草稿/结果二态视图）、草稿保存与交卷
 * mutation。两种来源共用 /attempts/:id/* 接口与答题页（D9）。
 */

/** 单个 attempt 详情 key */
export const studentAttemptKey = (attemptId: string) =>
  ["student", "attempt", attemptId] as const;

/** 课程单元落地页 key（题数/历次作答/汇总） */
export const studentUnitLandingKey = (courseId: string, unitId: string) =>
  ["student", "course", courseId, "unit", unitId] as const;

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

/** 单元落地信息（开始练习/继续作答/再做一次与历次记录列表的数据源） */
export function useStudentUnitLanding(courseId: string, unitId: string) {
  return useQuery({
    queryKey: studentUnitLandingKey(courseId, unitId),
    queryFn: () => fetchStudentUnitLandingApi(courseId, unitId),
    staleTime: 15_000,
  });
}

/** 创建/取回 attempt（作业来源入口；返回摘要含 status 决定走答题还是结果视图） */
export function useStartAttempt(assignmentId: string) {
  return useMutation({
    mutationFn: () => startAttemptApi(assignmentId),
  });
}

/**
 * 课程练习入口（T2A.6，D10）：开始/继续/再做一次。
 * 成功后失效落地页与课程列表（目录状态徽章、首页进度联动）。
 */
export function useStartCourseAttempt(courseId: string, unitId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => startCourseAttemptApi(courseId, unitId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: studentUnitLandingKey(courseId, unitId),
      });
    },
  });
}

/**
 * 交卷：成功后失效 attempt 详情、作业列表（首页状态徽章联动）与课程侧数据
 * （T2A.6：目录单元状态、单元落地页、首页课程卡片进度）；错题本与我的记录
 * 同步失效——交卷即产生新的已判定轮次（2026-10 重练后回错题本立即可见新轮次，
 * 不受 15s staleTime 影响看到旧聚合）。
 */
export function useSubmitAttempt(attemptId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => submitAttemptApi(attemptId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: studentAttemptKey(attemptId),
      });
      void queryClient.invalidateQueries({ queryKey: studentAssignmentsKey });
      void queryClient.invalidateQueries({ queryKey: studentCoursesKey });
      void queryClient.invalidateQueries({ queryKey: ["student", "course"] });
      // 前缀失效（studentWrongQuestionsKey 是带参函数，这里取其前两层前缀）
      void queryClient.invalidateQueries({
        queryKey: ["student", "wrong-questions"],
      });
      void queryClient.invalidateQueries({ queryKey: ["student", "records"] });
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
