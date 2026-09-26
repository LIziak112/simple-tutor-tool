import { useQuery } from "@tanstack/react-query";
import {
  fetchStudentAssignmentsApi,
  fetchStudentLectureApi,
  fetchStudentLecturesApi,
} from "@/lib/api";

/**
 * 学生端数据查询（T2.3）。「我的作业」与「讲义」都是登录学生本人的只读视图：
 * - 作业：状态徽章数据源（T2.2 接口，题目内容 T2.4 起另行下发）；
 * - 讲义：摘要列表（首页/列表页共用）与全文详情（阅读页）。
 * 三态由页面接 isPending / isError 呈现（UI 约定）。
 */

/** 我的作业列表 key */
export const studentAssignmentsKey = ["student", "assignments"] as const;

/** 我的作业（按布置时间倒序，含完成状态） */
export function useStudentAssignments() {
  return useQuery({
    queryKey: studentAssignmentsKey,
    queryFn: fetchStudentAssignmentsApi,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 讲义摘要列表 key（首页与列表页共用缓存） */
export const studentLecturesKey = ["student", "lectures"] as const;

/** 讲义摘要列表（按课程顺序） */
export function useStudentLectures() {
  return useQuery({
    queryKey: studentLecturesKey,
    queryFn: fetchStudentLecturesApi,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 单篇讲义全文 key */
export const studentLectureKey = (id: string) =>
  ["student", "lectures", id] as const;

/** 单篇讲义全文 markdown（阅读页渲染；KaTeX 随 RichMarkdown 按需加载） */
export function useStudentLecture(id: string) {
  return useQuery({
    queryKey: studentLectureKey(id),
    queryFn: () => fetchStudentLectureApi(id),
    enabled: id.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
