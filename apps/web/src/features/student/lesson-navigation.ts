/**
 * 讲练页路由工具（2026-10 讲练一体）：/s/lectures/:id/lesson 的学生端
 * 拼接单源（讲义列表/课程目录/阅读页重定向/交卷后返回目标四处共用；
 * courseId 上下文随行，缺省不带 query）。惯例同 record-review-navigation
 * （学生端路由 helper 就近收在 features/student）。
 */

/** 讲练页地址（courseId 传 null/undefined 时不带课程上下文） */
export function lessonHref(
  lectureId: string,
  courseId?: string | null,
): string {
  return `/s/lectures/${lectureId}/lesson${
    courseId ? `?courseId=${courseId}` : ""
  }`;
}
