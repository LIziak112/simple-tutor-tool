import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchLessonLandingApi,
  restartLessonAttemptApi,
  startLessonAttemptApi,
} from "@/lib/api";

/**
 * 讲练页数据层（2026-10 讲练一体）：
 * - useLessonLanding：讲练落地页（开始练习/继续作答/重开三态入口 + 历次记录
 *   的数据源）；staleTime 0——从作答页返回时总能看到最新历次；
 * - useLessonStart：进入讲练页即幂等开卷（create-or-return——进行中返回同一份
 *   draft、已完成返回最新那份，刷新安全不消耗 attemptNo）。refetch 即
 *   「刷新」：进行中卷重新拉 start 可取到教师课中批改结果（teacherMark/
 *   finalCorrect 随 released 下发，方案决策 4）；
 * - useRestartLesson：「再做一次/重新开始」显式独立动作（2026-10 教师演示
 *   口径随时可用：进行中卷先作废再开新卷），成功后失效讲练开卷/落地缓存与
 *   记录/错题聚合（新一轮已产生）。
 */

/** 讲练开卷投影 key（courseId 参与缓存键：课程上下文随 query 下发） */
export const studentLessonKey = (
  lectureId: string,
  courseId?: string | undefined,
) => ["student", "lesson", lectureId, courseId ?? null] as const;

/** 讲练落地页 key（courseId 参与缓存键） */
export const studentLessonLandingKey = (
  lectureId: string,
  courseId?: string | undefined,
) => ["student", "lesson-landing", lectureId, courseId ?? null] as const;

/** 讲练落地页（三态入口 + 历次记录） */
export function useLessonLanding(
  lectureId: string | undefined,
  courseId?: string | undefined,
) {
  return useQuery({
    queryKey: studentLessonLandingKey(lectureId ?? "pending", courseId),
    queryFn: () => fetchLessonLandingApi(lectureId ?? "", courseId),
    enabled: lectureId !== undefined && lectureId.length > 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

/**
 * 讲练开卷投影（幂等 create-or-return）。三态由页面接 isPending / isError。
 */
export function useLessonStart(
  lectureId: string | undefined,
  courseId?: string | undefined,
) {
  return useQuery({
    queryKey: studentLessonKey(lectureId ?? "pending", courseId),
    queryFn: () => startLessonAttemptApi(lectureId ?? "", courseId),
    enabled: lectureId !== undefined && lectureId.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 「再做一次/重新开始」：随时重开新卷（进行中先作废）；成功后失效开卷/落地与聚合缓存 */
export function useRestartLesson(lectureId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => restartLessonAttemptApi(lectureId),
    onSuccess: () => {
      // 前缀失效：courseId 维度无关（同一讲练页任意课程上下文一起刷新）
      void queryClient.invalidateQueries({ queryKey: ["student", "lesson"] });
      void queryClient.invalidateQueries({
        queryKey: ["student", "lesson-landing"],
      });
      void queryClient.invalidateQueries({ queryKey: ["student", "records"] });
      void queryClient.invalidateQueries({
        queryKey: ["student", "wrong-questions"],
      });
    },
  });
}
