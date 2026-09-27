import { z } from "zod";

/**
 * 学生端课程契约（T2A.5 起为权威定义）：我的课程列表、课程可见目录（按 D5 过滤）
 * 的响应 data 与错误码。讲义列表分组视图与讲义详情的配套练习扩展在 content-api.ts
 * （studentLectureCourseGroupSchema / studentLectureDetailSchema，与讲义摘要同文件）。
 * 依据：docs/Phase2改进任务清单.md §5 T2A.5、§2 D5（学生可见规则）、D8（配套练习）、
 * D22（访问错误码）。
 *
 * 约定（与 course-api.ts / content-api.ts 一致）：
 * - 本文件只定义请求/响应 data 部分；响应壳 { ok, data } / { ok, error, message } 由
 *   index.ts 统一描述，此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 全部为学生端接口（requireStudent）：响应**只含目录与资源元信息**，不得携带任何
 *   题目内容字段（stemMd/optionsJson/questions 等，AGENTS.md 第 3 条），泄露测试
 *   见 apps/server/src/routes/student-courses.test.ts；
 * - 隐藏条目零信息（T2A.5 要点）：可见性由 canStudentSeeItem 唯一判定，隐藏/未到
 *   发布时间/资源已删除的条目不出现在 items，也不计入任何计数；
 * - 课程名口径：清单用 name，数据库列为 title——响应字段统一用 name（与 course-api
 *   一致）；时间为 UTC ISO 字符串，界面转 Asia/Shanghai。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 我的课程（GET /api/student/courses） ----------

/**
 * 学生端课程摘要（「我的课程」卡片数据源：首页与 /s/courses 共用）。
 * - visibleLectureCount / visibleUnitCount：该生此刻按 D5 可见的讲义/单元条目数
 *   （隐藏条目不计入——不通过计数差异泄露存在性）；
 * - completedUnitCount：已完成单元数（至少交卷 1 次的可见单元数；T2A.6 接入课程
 *   练习作答后填充，本任务恒返回 0，前端进度条按 0 渲染）。
 */
export const studentCourseSummarySchema = z.object({
  id: z.uuid(),
  /** 课程名（courses.title） */
  name: z.string().min(1),
  description: z.string().nullable(),
  /** 可见讲义条目数（D5） */
  visibleLectureCount: z.number().int().min(0),
  /** 可见单元条目数（D5） */
  visibleUnitCount: z.number().int().min(0),
  /** 已完成单元数（T2A.6 前恒 0） */
  completedUnitCount: z.number().int().min(0),
});

/**
 * GET /api/student/courses 响应 data：该生为成员且未归档的全部课程
 * （按 course.order 升序）。归档课程与非成员课程不出现在列表（零信息）。
 */
export const studentCourseListDataSchema = z.object({
  courses: z.array(studentCourseSummarySchema),
});

// ---------- 课程可见目录（GET /api/student/courses/:id） ----------

/**
 * 学生端目录条目（按 D5 过滤后仅含可见条目，order 升序）。
 * - kind：section=分节标题（仅文字）/ lecture=讲义 / unit=练习单元；
 * - questionCount：单元条目的未删除题目数（前端显示「n 题 · 即将开放」，作答入口
 *   T2A.6 开放）；分节与讲义条目为 null；
 * - 讲义条目点击进入 /s/lectures/:refId?courseId=<课程 id>（带课程上下文）。
 */
export const studentCourseItemSchema = z.object({
  /** course_items.id */
  id: z.uuid(),
  kind: z.enum(["section", "lecture", "unit"]),
  /** 引用资源 id（lectures.id / units.id）；分节为 null */
  refId: z.string().nullable(),
  /** 显示标题：分节 = 分节标题；讲义/单元 = 资源当前标题 */
  title: z.string().min(1),
  /** 课程内排序（小在前） */
  order: z.number().int().min(0),
  /** 单元条目的未删除题目数；分节/讲义为 null */
  questionCount: z.number().int().min(0).nullable(),
});

/**
 * GET /api/student/courses/:id 响应 data：课程名 + 简介 + 可见目录。
 * 错误（D22）：非成员或课程已归档 → 403 COURSE_ACCESS_DENIED；
 * 课程不存在 → 404 NOT_FOUND（不暴露存在性）。
 */
export const studentCourseDetailDataSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  /** 可见目录条目（order 升序；隐藏条目零信息） */
  items: z.array(studentCourseItemSchema),
});

// ---------- 错误码（D22 学生访问课程资源） ----------

/**
 * 学生端课程访问错误码：
 * - COURSE_ACCESS_DENIED：非成员、学生已归档或课程已归档（403）；
 * - NOT_FOUND：课程/条目不存在、条目隐藏、未到发布时间、资源已删除、不在该课程
 *   目录中（404，不暴露存在性——与教师侧资源级 404 码区分，统一用 NOT_FOUND）。
 * 作业相关错误码维持现状（assignment.ts，未被指派 403）。
 */
export const studentCourseErrorCodeSchema = z.enum([
  "COURSE_ACCESS_DENIED",
  "NOT_FOUND",
]);

// ---------- 具体化的成功壳 ----------

export const studentCourseListOkSchema = apiOkExtend(studentCourseListDataSchema);
export const studentCourseDetailOkSchema = apiOkExtend(
  studentCourseDetailDataSchema,
);

// ---------- 推断类型导出 ----------

export type StudentCourseSummary = z.infer<typeof studentCourseSummarySchema>;
export type StudentCourseListData = z.infer<typeof studentCourseListDataSchema>;
export type StudentCourseItem = z.infer<typeof studentCourseItemSchema>;
export type StudentCourseDetailData = z.infer<
  typeof studentCourseDetailDataSchema
>;
export type StudentCourseErrorCode = z.infer<
  typeof studentCourseErrorCodeSchema
>;
