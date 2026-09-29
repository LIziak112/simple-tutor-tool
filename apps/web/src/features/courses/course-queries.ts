import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CourseCreateRequest,
  CourseDetailData,
  CourseItemsAddData,
  CourseItemsAddRequest,
  CourseItemsReorderRequest,
  CourseItemUpdateRequest,
  CourseUpdateRequest,
} from "@tutor/contract";
import {
  addCourseItemsApi,
  addCourseMembersApi,
  createCourseApi,
  deleteCourseApi,
  deleteCourseItemApi,
  fetchCourseDetail,
  fetchCourseStudentView,
  fetchTeacherCourses,
  removeCourseMembersApi,
  reorderCourseItemsApi,
  updateCourseApi,
  updateCourseItemApi,
} from "@/lib/api";

/**
 * 课程页面的 TanStack Query 封装（T2A.4）：
 * - 列表按 archived 分 key（归档筛选是两个独立视图）；
 * - 详情按课程 id 缓存；任何写操作成功后整组失效（courses 前缀），
 *   学生页「所在课程」列也依赖同一列表缓存。
 */

/** 课程列表 query key（archived 进入 key） */
export const coursesKey = (archived: boolean) =>
  ["teacher", "courses", { archived }] as const;

/** 课程详情 query key */
export const courseDetailKey = (id: string) =>
  ["teacher", "courses", "detail", id] as const;

/** 课程列表 */
export function useTeacherCourses(archived: boolean) {
  return useQuery({
    queryKey: coursesKey(archived),
    queryFn: () => fetchTeacherCourses(archived),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 课程详情（目录 + 成员 + hasAttempts） */
export function useCourseDetail(id: string) {
  return useQuery({
    queryKey: courseDetailKey(id),
    queryFn: () => fetchCourseDetail(id),
    enabled: id.length > 0,
  });
}

/** 学生可见预览（成员视角的 D5 过滤目录；studentId 为空不查） */
export function useCourseStudentView(
  courseId: string,
  studentId: string | null,
) {
  return useQuery({
    queryKey: ["teacher", "courses", "student-view", courseId, studentId],
    queryFn: () => fetchCourseStudentView(courseId, studentId as string),
    enabled: studentId !== null && studentId.length > 0,
  });
}

/** 写操作完成后失效课程相关缓存（列表 + 本课程详情 + 学生可见预览） */
function useInvalidateCourses(courseId?: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["teacher", "courses"] });
    if (courseId !== undefined) {
      void queryClient.invalidateQueries({
        queryKey: courseDetailKey(courseId),
      });
    }
  };
}

/** 新建课程 */
export function useCreateCourse() {
  const invalidate = useInvalidateCourses();
  return useMutation({
    mutationFn: (request: CourseCreateRequest) => createCourseApi(request),
    onSuccess: invalidate,
  });
}

/** 更新课程（改名/简介/归档） */
export function useUpdateCourse(courseId: string) {
  const invalidate = useInvalidateCourses(courseId);
  return useMutation({
    mutationFn: (request: CourseUpdateRequest) =>
      updateCourseApi(courseId, request),
    onSuccess: invalidate,
  });
}

/** 删除课程（有作答或作业 409 COURSE_HAS_ATTEMPTS，由调用方 catch 提示改用归档） */
export function useDeleteCourse() {
  const invalidate = useInvalidateCourses();
  return useMutation({
    mutationFn: (id: string) => deleteCourseApi(id),
    onSuccess: invalidate,
  });
}

/** 批量追加目录条目（返回新增与跳过清单，页面 toast 汇总展示） */
export function useAddCourseItems(courseId: string) {
  const invalidate = useInvalidateCourses(courseId);
  return useMutation<CourseItemsAddData, Error, CourseItemsAddRequest>({
    mutationFn: (request) => addCourseItemsApi(courseId, request),
    onSuccess: invalidate,
  });
}

/** 更新目录条目（可见开关 / 定时发布 / 分节改名） */
export function useUpdateCourseItem(courseId: string) {
  const invalidate = useInvalidateCourses(courseId);
  return useMutation<
    CourseDetailData["items"][number],
    Error,
    { id: string; request: CourseItemUpdateRequest }
  >({
    mutationFn: ({ id, request }) => updateCourseItemApi(id, request),
    onSuccess: invalidate,
  });
}

/** 移除目录条目 */
export function useDeleteCourseItem(courseId: string) {
  const invalidate = useInvalidateCourses(courseId);
  return useMutation({
    mutationFn: (id: string) => deleteCourseItemApi(id),
    onSuccess: invalidate,
  });
}

/** 目录排序（拖拽与上移/下移按钮共用） */
export function useReorderCourseItems(courseId: string) {
  const invalidate = useInvalidateCourses(courseId);
  return useMutation({
    mutationFn: (request: CourseItemsReorderRequest) =>
      reorderCourseItemsApi(courseId, request),
    onSuccess: invalidate,
  });
}

/** 添加成员 */
export function useAddCourseMembers(courseId: string) {
  const invalidate = useInvalidateCourses(courseId);
  return useMutation({
    mutationFn: (studentIds: string[]) =>
      addCourseMembersApi(courseId, { studentIds }),
    onSuccess: invalidate,
  });
}

/** 移出成员（D7：不删数据） */
export function useRemoveCourseMembers(courseId: string) {
  const invalidate = useInvalidateCourses(courseId);
  return useMutation({
    mutationFn: (studentIds: string[]) =>
      removeCourseMembersApi(courseId, { studentIds }),
    onSuccess: invalidate,
  });
}

/**
 * 把一名学生加入多门课程（学生页「新增学生时可选加入课程」）。
 * 顺序执行（量级小），任一失败整体抛错（调用方提示后可重试）。
 */
export function useAddStudentToCourses() {
  const invalidate = useInvalidateCourses();
  return useMutation({
    mutationFn: async ({
      studentId,
      courseIds,
    }: {
      studentId: string;
      courseIds: string[];
    }) => {
      for (const courseId of courseIds) {
        await addCourseMembersApi(courseId, { studentIds: [studentId] });
      }
    },
    onSuccess: invalidate,
  });
}

/**
 * 按勾选结果同步一名学生的课程成员关系（学生页「管理课程」行操作）。
 * add/remove 都是显式清单——未列出的课程（如已归档课程）不动，避免误移出。
 */
export function useSyncStudentCourses() {
  const invalidate = useInvalidateCourses();
  return useMutation({
    mutationFn: async ({
      studentId,
      addCourseIds,
      removeCourseIds,
    }: {
      studentId: string;
      addCourseIds: string[];
      removeCourseIds: string[];
    }) => {
      for (const courseId of addCourseIds) {
        await addCourseMembersApi(courseId, { studentIds: [studentId] });
      }
      for (const courseId of removeCourseIds) {
        await removeCourseMembersApi(courseId, { studentIds: [studentId] });
      }
    },
    onSuccess: invalidate,
  });
}
