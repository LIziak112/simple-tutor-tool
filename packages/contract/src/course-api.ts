import { z } from "zod";

/**
 * 课程 API 契约（T2A.4 起为权威定义）：教师端课程编辑页（目录编排 + 可见性 + 成员）
 * 与学生页「所在课程」列的请求体/响应 data、错误码。
 * 依据：docs/archive/Phase2A改进任务清单.md §5 T2A.4、§2 D4（删除/归档）、D5（学生可见规则）、
 * D6（课程目录）、D7（课程成员）、D8（配套练习）；§4 教师端通用使用约定。
 *
 * 约定（与 content-api.ts / library-api.ts 一致）：
 * - 本文件只定义请求体与 data 部分；响应壳 { ok, data } / { ok, error, message } 由
 *   index.ts 统一描述，此处仅用局部 helper 具体化成功壳；
 * - 全部为教师端接口（requireTeacher），无泄露约束（student-view 亦为教师接口，
 *   响应只含目录元信息，不含任何题目内容）；
 * - 课程名口径：清单用 name，数据库列为 title——本契约响应字段统一用 name
 *   （PATCH 请求同时接受 name 与旧字段 title，见 content-api.ts courseUpdateRequestSchema）；
 * - 时间：publishAt / archivedAt / joinedAt 为 UTC ISO 字符串（§0.3），界面转 Asia/Shanghai。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 课程列表（GET /api/teacher/courses?archived） ----------

/**
 * 列表查询参数：archived 缺省 / false = 只列未归档课程；true = 只列已归档
 * （教师端「归档筛选」两个视图；D4：归档课程学生端不可见，教师可查看、可恢复）。
 */
export const courseListQuerySchema = z.object({
  archived: z.stringbool().optional(),
});

/** 课程名（trim 后 1–100 字符；映射到 courses.title 列） */
export const courseNameSchema = z
  .string()
  .trim()
  .min(1, "课程名不能为空")
  .max(100, "课程名最多 100 个字符");

/** 课程简介（trim 后可空，空存 null；最多 500 字符） */
export const courseDescriptionSchema = z
  .string()
  .trim()
  .max(500, "课程简介最多 500 个字符");

/**
 * 课程摘要（GET /api/teacher/courses 列表项）。
 * - memberCount / itemCount / visibleItemCount：§4-4 状态一目了然；
 * - visibleItemCount 口径：visible=true 且被引用资源未软删的条目数
 *   （publishAt 未到点不扣减——「定时」条目仍计入，属配置口径而非此刻可见口径；
 *   「无题目」单元同样计入，学生侧真实可见数以 student-view 为准）；
 * - memberIds：成员学生 id 集合（学生页「所在课程」列 / 「管理课程」的数据源；
 *   一对一辅导量级小，直接随列表下发避免 N 次详情请求）；
 * - hasAttempts：是否有作答记录或按课程布置的作业（D4 删除条件，前端禁用删除
 *   按钮用；只布置了作业、尚无作答的课程也为 true——删除会连带影响作业）。
 */
export const courseSummarySchema = z.object({
  id: z.uuid(),
  /** 课程名（courses.title） */
  name: z.string().min(1),
  description: z.string().nullable(),
  /** 是否已归档（archivedAt 非空） */
  archived: z.boolean(),
  /** 归档时间；未归档为 null */
  archivedAt: z.string().nullable(),
  /** 同级排序（小在前） */
  order: z.number().int().min(0),
  /** 成员学生数 */
  memberCount: z.number().int().min(0),
  /** 目录条目总数（含分节） */
  itemCount: z.number().int().min(0),
  /** 可见条目数（口径见 courseSummarySchema 注释） */
  visibleItemCount: z.number().int().min(0),
  /** 成员学生 id 列表（与 memberCount 同源） */
  memberIds: z.array(z.uuid()),
  /**
   * 是否有作答记录或按课程布置的作业（D4：true 时删除按钮禁用并提示改用归档；
   * 只布置了作业、尚无作答的课程也为 true——删除会连带影响作业）
   */
  hasAttempts: z.boolean(),
  createdAt: z.string().min(1),
});

/** GET /api/teacher/courses 响应 data（order 升序） */
export const courseListDataSchema = z.object({
  courses: z.array(courseSummarySchema),
});

// ---------- 课程详情（GET /api/teacher/courses/:id） ----------

/**
 * 目录条目的状态标签（§4-4：可见 / 隐藏 / 定时（M月D日 HH:mm 发布）/ 已删除 / 无题目）。
 * 服务端计算，前端只渲染文案与时间：
 * - deleted：被引用资源已软删（lecture/unit；分节不会出现该状态）；
 * - no-questions：单元条目未删除题目数为 0（D5 条件 4 不可见）；
 * - hidden：visible=false（优先于 scheduled——教师显式隐藏时按隐藏展示）；
 * - scheduled：visible=true 且 publishAt 在未来；
 * - visible：其余（visible=true，publishAt 为空或已到点，资源正常）。
 */
export const courseItemStatusSchema = z.enum([
  "visible",
  "hidden",
  "scheduled",
  "deleted",
  "no-questions",
]);

/** 课程详情中的目录条目（含资源摘要与状态标签数据） */
export const courseDetailItemSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["section", "lecture", "unit"]),
  /** 引用资源 id；分节为 null */
  refId: z.string().nullable(),
  /** 显示标题：分节 = 分节标题；讲义/单元 = 资源当前标题 */
  title: z.string().min(1),
  /** 课程内排序（小在前；全 kind 共用一个序列） */
  order: z.number().int().min(0),
  /** 是否对学生可见（D5 条件 3） */
  visible: z.boolean(),
  /** 定时发布时间；不定时为 null */
  publishAt: z.string().nullable(),
  /** 状态标签数据（见 courseItemStatusSchema） */
  status: courseItemStatusSchema,
  /** 单元条目的未删除题目数；其余 kind 为 null */
  questionCount: z.number().int().min(0).nullable(),
  /** 资源最近更新时间（讲义/单元）；分节为 null */
  resourceUpdatedAt: z.string().nullable(),
  createdAt: z.string().min(1),
});

/** 课程详情中的成员（含学生归档标记，供成员页签展示） */
export const courseMemberSchema = z.object({
  studentId: z.uuid(),
  displayName: z.string().min(1),
  joinedAt: z.string().min(1),
  /** 该学生是否已归档（归档学生看不到课程，D5 条件 1） */
  archived: z.boolean(),
});

/** GET /api/teacher/courses/:id 响应 data（目录条目按 order 升序，成员按姓名排序） */
export const courseDetailDataSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  order: z.number().int().min(0),
  /** 是否有作答记录或按课程布置的作业（D4 删除条件；口径同列表 hasAttempts） */
  hasAttempts: z.boolean(),
  items: z.array(courseDetailItemSchema),
  members: z.array(courseMemberSchema),
  createdAt: z.string().min(1),
});

// ---------- 目录条目：批量添加（POST /api/teacher/courses/:id/items） ----------

/** 批量添加的单条输入（kind 决定 refId/title 必填性，服务层校验） */
export const courseItemInputSchema = z.object({
  kind: z.enum(["section", "lecture", "unit"]),
  /** lecture/unit 必填（资源 id）；section 必须为空 */
  refId: z.string().min(1).optional(),
  /** section 必填（分节标题）；lecture/unit 必须为空（标题取资源当前值） */
  title: z.string().trim().min(1).max(100).optional(),
});

/**
 * POST /api/teacher/courses/:id/items 请求体：
 * - items 追加到目录末尾（保持传入顺序）；同一资源已在本课程 → 跳过并记入
 *   skipped 清单（D6 批量口径，与单条添加的 409 不同）；
 * - visible：本批新添条目是否对学生可见（缺省 true，D6「添加后对学生可见」开关默认开）；
 * - withCompanionUnits：D8——为每个讲义条目一并添加以它为配套讲义
 *   （units.lectureId）且未软删的单元（同样跳过已在课程/本批重复者），
 *   追加位置紧跟对应讲义之后。
 */
export const courseItemsAddRequestSchema = z.object({
  items: z.array(courseItemInputSchema).min(1, "items 不能为空"),
  visible: z.boolean().optional(),
  withCompanionUnits: z.boolean().optional(),
});

/** 批量添加成功落入的新条目 */
export const courseItemAddedSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["section", "lecture", "unit"]),
  refId: z.string().nullable(),
  /** 显示标题（分节标题 / 资源当前标题） */
  title: z.string().min(1),
  order: z.number().int().min(0),
  visible: z.boolean(),
  /** 是否因 D8 配套练习自动带入（前端 toast 区分展示） */
  companion: z.boolean(),
});

/** 批量添加被跳过的条目（reason 为可直接展示的中文） */
export const courseItemSkippedSchema = z.object({
  kind: z.enum(["section", "lecture", "unit"]),
  refId: z.string().nullable(),
  /** 显示标题（尽力取资源当前标题；分节为传入标题） */
  title: z.string().nullable(),
  /** 跳过原因：「已在本课程」/「同一次添加中重复」 */
  reason: z.string().min(1),
});

/** POST /api/teacher/courses/:id/items 响应 data */
export const courseItemsAddDataSchema = z.object({
  added: z.array(courseItemAddedSchema),
  skipped: z.array(courseItemSkippedSchema),
});

// ---------- 目录条目：更新 / 删除 / 排序 ----------

/**
 * PATCH /api/teacher/course-items/:id 请求体（字段缺省 = 不改）：
 * - visible：条目可见开关（D5 条件 3）；
 * - publishAt：定时发布时间（UTC ISO）；显式 null = 取消定时；
 * - title：仅分节条目可改（讲义/单元标题取资源当前值，服务层 422 拦截）。
 */
export const courseItemUpdateRequestSchema = z.object({
  visible: z.boolean().optional(),
  publishAt: z.iso.datetime({ offset: false }).nullable().optional(),
  title: z.string().trim().min(1, "分节标题不能为空").max(100).optional(),
});

/** PATCH /api/teacher/course-items/:id 响应 data：更新后的条目（含状态标签数据） */
export const courseItemDataSchema = courseDetailItemSchema;

/** PUT /api/teacher/courses/:id/items/order 请求体：该课程全部条目的完整新顺序 */
export const courseItemsReorderRequestSchema = z.object({
  ids: z
    .array(z.uuid("id 必须是 UUID 格式"))
    .refine((ids) => ids.length > 0, "ids 不能为空")
    .refine((ids) => new Set(ids).size === ids.length, "ids 不能有重复"),
});

// ---------- 课程成员（D7） ----------

/** POST/DELETE /api/teacher/courses/:id/members 请求体 */
export const courseMembersRequestSchema = z.object({
  studentIds: z
    .array(z.uuid("studentId 必须是 UUID 格式"))
    .min(1, "studentIds 不能为空")
    .refine((ids) => new Set(ids).size === ids.length, "studentIds 不能有重复"),
});

// ---------- 学生可见预览（GET /api/teacher/courses/:id/student-view） ----------

/** 查询参数：以哪位成员的视角预览（D5 条件 1 要求成员资格） */
export const courseStudentViewQuerySchema = z.object({
  studentId: z.uuid("studentId 必须是 UUID 格式"),
});

/** 学生可见目录条目（listVisibleItems 按 D5 过滤后的形状） */
export const courseStudentViewItemSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["section", "lecture", "unit"]),
  refId: z.string().nullable(),
  title: z.string().min(1),
  order: z.number().int().min(0),
});

/**
 * GET /api/teacher/courses/:id/student-view 响应 data（§4-10 学生可见预览）。
 * items 为该成员此刻可见的目录（canStudentSeeItem 唯一判定，D5）；
 * courseArchived / studentArchived / isMember 供前端解释空目录的原因。
 */
export const courseStudentViewDataSchema = z.object({
  studentId: z.uuid(),
  studentName: z.string().min(1),
  /** 课程是否已归档（归档 → 全部成员不可见） */
  courseArchived: z.boolean(),
  /** 该学生是否已归档 */
  studentArchived: z.boolean(),
  /** 该学生是否为课程成员 */
  isMember: z.boolean(),
  items: z.array(courseStudentViewItemSchema),
});

// ---------- 课程进度矩阵（GET /api/teacher/courses/:id/progress，T2A.6） ----------

/**
 * 矩阵单元格：一位成员 × 一个可见单元的课程练习统计（D10；只统计
 * sourceType='course' 的作答，作业作答不计入）。
 * - count / submittedCount / first/latest/bestScore / pendingCount 口径与
 *   studentUnitAttemptSummarySchema 一致（首次得分最能反映真实掌握程度）；
 * - latestSubmittedAt：最近一次交卷时间（UTC ISO；从未交卷为 null）；
 * - history：历次作答列表（attemptNo 降序；点击单元格展开显示，详情页属 T3.1）；
 * 该生在该单元从未做过时整个单元格为 null。
 */
export const courseProgressCellSchema = z.object({
  studentId: z.uuid(),
  unitId: z.string().min(1),
  count: z.number().int().min(0),
  submittedCount: z.number().int().min(0),
  firstScore: z.number().int().min(0).max(100).nullable(),
  latestScore: z.number().int().min(0).max(100).nullable(),
  bestScore: z.number().int().min(0).max(100).nullable(),
  pendingCount: z.number().int().min(0),
  /** 最近一次交卷时间：UTC ISO；从未交卷为 null */
  latestSubmittedAt: z.string().nullable(),
  /** 历次作答（attemptNo 降序；只含元信息，无任何题目内容） */
  history: z.array(
    z.object({
      attemptId: z.uuid(),
      attemptNo: z.number().int().min(1),
      status: z.enum(["draft", "submitted", "graded"]),
      score: z.number().int().min(0).max(100).nullable(),
      submittedAt: z.string().nullable(),
    }),
  ),
});

/** 矩阵的单元列：可见单元（visible=true 且已到发布时间且资源未删且有题，D5 教师侧口径） */
export const courseProgressUnitSchema = z.object({
  unitId: z.string().min(1),
  title: z.string().min(1),
  /** 目录条目顺序（矩阵列顺序） */
  order: z.number().int().min(0),
});

/**
 * GET /api/teacher/courses/:id/progress 响应 data：成员 × 可见单元矩阵。
 * members（行）按姓名排序；units（列）按目录条目顺序；cells 按成员 × 单元给出，
 * 缺席（从未做过）的单元格不出现在 cells（前端按 null 渲染）。
 */
export const courseProgressDataSchema = z.object({
  courseId: z.uuid(),
  /** 课程成员（行；含已归档学生——教师侧保留统计视角） */
  members: z.array(
    z.object({
      studentId: z.uuid(),
      displayName: z.string().min(1),
      archived: z.boolean(),
    }),
  ),
  /** 可见单元（列） */
  units: z.array(courseProgressUnitSchema),
  /** 有作答的单元格（缺席 = 从未做过） */
  cells: z.array(courseProgressCellSchema),
});

// ---------- 错误码 ----------

/**
 * 课程相关错误码（本文件接口的固定子集；课程本体的 CRUD 错误码在 content-api.ts）：
 * - COURSE_NOT_FOUND：课程不存在（404）；
 * - COURSE_ITEM_NOT_FOUND：目录条目不存在（404）；
 * - DUPLICATE_COURSE_ITEM：同一资源重复加入同一课程（409；批量添加接口为跳过口径，
 *   该码保留给单条/其他添加路径，见 D6）；
 * - STUDENT_NOT_FOUND：成员接口的学生 id 不存在（404）；
 * - COURSE_HAS_ATTEMPTS：删除被拒——课程有作答记录或按课程布置的作业
 *   （409，D4，提示改用归档）。
 */
export const courseErrorCodeSchema = z.enum([
  "COURSE_NOT_FOUND",
  "COURSE_ITEM_NOT_FOUND",
  "DUPLICATE_COURSE_ITEM",
  "STUDENT_NOT_FOUND",
  "COURSE_HAS_ATTEMPTS",
]);

// ---------- 具体化的成功壳 ----------

export const courseListOkSchema = apiOkExtend(courseListDataSchema);
export const courseDetailOkSchema = apiOkExtend(courseDetailDataSchema);
export const courseItemsAddOkSchema = apiOkExtend(courseItemsAddDataSchema);
export const courseItemOkSchema = apiOkExtend(courseItemDataSchema);
export const courseStudentViewOkSchema = apiOkExtend(
  courseStudentViewDataSchema,
);
export const courseProgressOkSchema = apiOkExtend(courseProgressDataSchema);

// ---------- 推断类型导出 ----------

export type CourseListQuery = z.infer<typeof courseListQuerySchema>;
export type CourseSummary = z.infer<typeof courseSummarySchema>;
export type CourseListData = z.infer<typeof courseListDataSchema>;
export type CourseItemStatus = z.infer<typeof courseItemStatusSchema>;
export type CourseDetailItem = z.infer<typeof courseDetailItemSchema>;
export type CourseMember = z.infer<typeof courseMemberSchema>;
export type CourseDetailData = z.infer<typeof courseDetailDataSchema>;
export type CourseItemInput = z.infer<typeof courseItemInputSchema>;
export type CourseItemsAddRequest = z.infer<typeof courseItemsAddRequestSchema>;
export type CourseItemAdded = z.infer<typeof courseItemAddedSchema>;
export type CourseItemSkipped = z.infer<typeof courseItemSkippedSchema>;
export type CourseItemsAddData = z.infer<typeof courseItemsAddDataSchema>;
export type CourseItemUpdateRequest = z.infer<
  typeof courseItemUpdateRequestSchema
>;
export type CourseItemData = z.infer<typeof courseItemDataSchema>;
export type CourseItemsReorderRequest = z.infer<
  typeof courseItemsReorderRequestSchema
>;
export type CourseMembersRequest = z.infer<typeof courseMembersRequestSchema>;
export type CourseStudentViewQuery = z.infer<
  typeof courseStudentViewQuerySchema
>;
export type CourseStudentViewItem = z.infer<typeof courseStudentViewItemSchema>;
export type CourseStudentViewData = z.infer<typeof courseStudentViewDataSchema>;
export type CourseProgressCell = z.infer<typeof courseProgressCellSchema>;
export type CourseProgressUnit = z.infer<typeof courseProgressUnitSchema>;
export type CourseProgressData = z.infer<typeof courseProgressDataSchema>;
export type CourseErrorCode = z.infer<typeof courseErrorCodeSchema>;
