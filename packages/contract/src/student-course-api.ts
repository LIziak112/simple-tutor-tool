import { z } from "zod";

/**
 * 学生端课程契约（T2A.5 起为权威定义）：我的课程列表、课程可见目录（按 D5 过滤）
 * 的响应 data 与错误码。讲义列表分组视图与讲义详情的配套练习扩展在 content-api.ts
 * （studentLectureCourseGroupSchema / studentLectureDetailSchema，与讲义摘要同文件）。
 * 依据：docs/archive/Phase2A改进任务清单.md §5 T2A.5、§2 D5（学生可见规则）、D8（配套练习）、
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
 * - completedUnitCount：已完成单元数（T2A.6 起 = 至少交卷 1 次的可见单元数；
 *   作业作答不计入，D10「作业与课程练习互不计入对方次数」）。
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
  /** 已完成单元数（至少交卷 1 次的可见单元数） */
  completedUnitCount: z.number().int().min(0),
});

/**
 * GET /api/student/courses 响应 data：该生为成员且未归档的全部课程
 * （按 course.order 升序）。归档课程与非成员课程不出现在列表（零信息）。
 */
export const studentCourseListDataSchema = z.object({
  courses: z.array(studentCourseSummarySchema),
});

// ---------- 课程练习的作答状态（T2A.6，D10） ----------

/**
 * 目录单元条目上的课程练习作答摘要（D10：作答次数、首次/最近/最高得分、待批）。
 * 全部只统计 sourceType='course' 的作答（作业作答不计入）；该生从未做过为 null。
 * - count：全部作答次数（含进行中草稿）；
 * - submittedCount：已交卷次数；
 * - hasDraft：是否存在未交卷作答（「继续作答」入口依据，D10）；
 * - first/latest/bestScore：首次/最近/最高一次**已交卷**作答得分（0–100 整数百分比；
 *   scoreFinal ?? scoreAuto 口径；无可判分为 null）——首次得分最能反映真实掌握
 *   程度，教师侧统计优先使用它；
 * - pendingCount：待批题数（D4 共享谓词：已交卷 attempt 中 finalCorrect 为 null
 *   的题数；draft 恒 0；含只写笔迹未填最终答案的手写题）。
 */
export const studentUnitAttemptSummarySchema = z.object({
  count: z.number().int().min(0),
  submittedCount: z.number().int().min(0),
  hasDraft: z.boolean(),
  firstScore: z.number().int().min(0).max(100).nullable(),
  latestScore: z.number().int().min(0).max(100).nullable(),
  bestScore: z.number().int().min(0).max(100).nullable(),
  pendingCount: z.number().int().min(0),
});

// ---------- 课程可见目录（GET /api/student/courses/:id） ----------

/**
 * 学生端目录条目（按 D5 过滤后仅含可见条目，order 升序）。
 * - kind：section=分节标题（仅文字）/ lecture=讲义 / unit=练习单元；
 * - questionCount：单元条目的未删除题目数；分节与讲义条目为 null；
 * - attempt：单元条目的课程练习作答摘要（T2A.6 起）；从未做为 null。目录单元项
 *   据此显示「未做 / 进行中 / 已完成（最近 xx 分 · 共 n 次）/ 有待批」；
 * - 讲义条目点击进入 /s/lectures/:refId?courseId=<课程 id>（带课程上下文）；
 * - 单元条目点击进入 /s/courses/:courseId/units/:refId（单元落地页，T2A.6）。
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
  /** 单元条目的课程练习作答摘要；从未做为 null */
  attempt: studentUnitAttemptSummarySchema.nullable(),
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

// ---------- 单元落地页（GET /api/student/courses/:id/units/:unitId，T2A.6） ----------

/**
 * 历次作答记录行（D10 历次保留；点击进入该次结果视图，只读）。
 * - score：scoreFinal ?? scoreAuto 口径；未交卷或无可判分为 null；
 * - attemptId 供进入 /s/attempts/:attemptId。
 */
export const studentUnitAttemptRecordSchema = z.object({
  attemptId: z.uuid(),
  /** 第几次作答（从 1 起） */
  attemptNo: z.number().int().min(1),
  status: z.enum(["draft", "submitted", "graded"]),
  /** 得分（0–100 整数百分比；未交/无可判分为 null） */
  score: z.number().int().min(0).max(100).nullable(),
  /** 开始时间：UTC ISO */
  startedAt: z.string().min(1),
  /** 交卷时间：UTC ISO；未交为 null */
  submittedAt: z.string().nullable(),
});

/**
 * GET /api/student/courses/:id/units/:unitId 响应 data：单元落地信息（D10）。
 * 题数与题型分布基于未删除题目；attempts 按 attemptNo 降序（最近在前）；
 * summary 为 null 表示从未做过（首次「开始练习」）。
 * 错误（D22）：非成员/学生归档/课程归档 → 403 COURSE_ACCESS_DENIED；
 * 课程或单元不存在/条目不可见 → 404 NOT_FOUND。
 */
export const studentUnitLandingDataSchema = z.object({
  courseId: z.uuid(),
  courseName: z.string().min(1),
  unitId: z.string().min(1),
  /** 单元标题（当前值，D1 引用而非复制） */
  title: z.string().min(1),
  /** 主题；未标注为 null */
  topic: z.string().nullable(),
  /** 未删除题目数 */
  questionCount: z.number().int().min(0),
  /** 题型分布：题型 → 题数（仅含有题数的题型） */
  typeDistribution: z.record(z.string(), z.number().int().min(1)),
  /** 历次作答（attemptNo 降序） */
  attempts: z.array(studentUnitAttemptRecordSchema),
  /** 作答汇总；从未做为 null */
  summary: studentUnitAttemptSummarySchema.nullable(),
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

export const studentCourseListOkSchema = apiOkExtend(
  studentCourseListDataSchema,
);
export const studentCourseDetailOkSchema = apiOkExtend(
  studentCourseDetailDataSchema,
);
export const studentUnitLandingOkSchema = apiOkExtend(
  studentUnitLandingDataSchema,
);

// ---------- 推断类型导出 ----------

export type StudentCourseSummary = z.infer<typeof studentCourseSummarySchema>;
export type StudentCourseListData = z.infer<typeof studentCourseListDataSchema>;
export type StudentUnitAttemptSummary = z.infer<
  typeof studentUnitAttemptSummarySchema
>;
export type StudentCourseItem = z.infer<typeof studentCourseItemSchema>;
export type StudentCourseDetailData = z.infer<
  typeof studentCourseDetailDataSchema
>;
export type StudentUnitAttemptRecord = z.infer<
  typeof studentUnitAttemptRecordSchema
>;
export type StudentUnitLandingData = z.infer<
  typeof studentUnitLandingDataSchema
>;
export type StudentCourseErrorCode = z.infer<
  typeof studentCourseErrorCodeSchema
>;
