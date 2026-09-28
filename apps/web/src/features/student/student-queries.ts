import { useQuery } from "@tanstack/react-query";
import {
  fetchStudentAssignmentsApi,
  fetchStudentCourseApi,
  fetchStudentCoursesApi,
  fetchStudentLectureApi,
  fetchStudentLecturesApi,
} from "@/lib/api";

/**
 * 学生端数据查询（T2.3；T2A.5 扩展课程与讲义 D5 可见性）。
 * 「我的作业」「我的课程」「讲义」都是登录学生本人的只读视图：
 * - 作业：状态徽章数据源（T2.2 接口，题目内容 T2.4 起另行下发）；
 * - 课程：我的课程卡片（首页与 /s/courses 共用缓存）与课程可见目录；
 * - 讲义：双视图摘要列表（首页入口/列表页共用）与全文详情（阅读页，带课程上下文）。
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

/** 我的课程列表 key（首页与课程页共用缓存） */
export const studentCoursesKey = ["student", "courses"] as const;

/** 我的课程（成员且未归档的课程，含可见讲义/单元计数与完成进度占位） */
export function useStudentCourses() {
  return useQuery({
    queryKey: studentCoursesKey,
    queryFn: fetchStudentCoursesApi,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 单个课程可见目录 key */
export const studentCourseKey = (id: string) =>
  ["student", "courses", id] as const;

/** 课程可见目录（D5 过滤：分节/讲义/单元条目，单元带题数；403 = 非成员或已归档） */
export function useStudentCourse(id: string) {
  return useQuery({
    queryKey: studentCourseKey(id),
    queryFn: () => fetchStudentCourseApi(id),
    enabled: id.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 讲义摘要列表 key（首页与列表页共用缓存） */
export const studentLecturesKey = ["student", "lectures"] as const;

/** 讲义摘要列表（D5：去重并集 + 按课程分组双视图） */
export function useStudentLectures() {
  return useQuery({
    queryKey: studentLecturesKey,
    queryFn: fetchStudentLecturesApi,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 单篇讲义全文 key（courseId 参与缓存键：不同课程上下文的配套练习不同） */
export const studentLectureKey = (id: string, courseId?: string | undefined) =>
  ["student", "lectures", id, courseId ?? null] as const;

/**
 * 单篇讲义全文 markdown（阅读页渲染；KaTeX 随 RichMarkdown 按需加载）。
 * courseId 缺省时服务端取第一个可见该讲义的课程。
 */
export function useStudentLecture(id: string, courseId?: string | undefined) {
  return useQuery({
    queryKey: studentLectureKey(id, courseId),
    queryFn: () => fetchStudentLectureApi(id, courseId),
    enabled: id.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
