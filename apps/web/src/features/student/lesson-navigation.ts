/**
 * 讲练路由工具（2026-10 讲练一体；10-13 教师演示口径拆双页）：
 * - lessonHref → 落地页 /s/lectures/:id/lesson（开始练习/继续作答/重开 +
 *   历次记录）：讲义列表/课程目录/阅读页重定向/交卷后返回目标共用；
 * - lessonRunHref → 作答页 /s/lectures/:id/lesson/run（md 段与题卡交错，
 *   进入即幂等开卷）：落地页入口按钮与历次 draft 行跳转用。
 * courseId 上下文随行，缺省不带 query。惯例同 record-review-navigation
 * （学生端路由 helper 就近收在 features/student）。
 */

/** 讲练落地页地址（courseId 传 null/undefined 时不带课程上下文） */
export function lessonHref(
  lectureId: string,
  courseId?: string | null,
): string {
  return `/s/lectures/${lectureId}/lesson${
    courseId ? `?courseId=${courseId}` : ""
  }`;
}

/** 讲练作答页地址（幂等开卷；courseId 传 null/undefined 时不带课程上下文） */
export function lessonRunHref(
  lectureId: string,
  courseId?: string | null,
): string {
  return `/s/lectures/${lectureId}/lesson/run${
    courseId ? `?courseId=${courseId}` : ""
  }`;
}
