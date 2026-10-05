import { z } from "zod";
import { lintIssueSchema, questionTypeSchema } from "./content.ts";

/**
 * 内容 API 契约（T1.10 起为权威定义）：教师端导入预览与提交的请求体/响应 data、
 * 导入相关错误码；T1.11 追加 GET /api/teacher/content 的内容树响应。
 * 依据：docs/技术架构与实施方案.md §5.1（linter 输出、导入 dry-run 预览）、§5.2（数据模型，
 * 导入落库的七张内容表）、docs/开发任务清单.md T1.10、T1.11、§0.3（响应壳/主键/时间约定）。
 *
 * 约定（与 auth.ts 一致）：
 * - 本文件只定义请求体与 data 部分；响应壳 { ok, data } / { ok, error, message } 由
 *   index.ts 统一描述，此处仅用局部 helper 具体化成功壳；
 * - 全部为教师端接口（requireTeacher），响应含答案/详解属正常（教师侧，无泄露约束）；
 * - preview 不写库；commit 有 error 级 issue 时返回 422 LINT_ERROR。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

/**
 * 导入规模上限（D20，前后端共用）：
 * - 单批文件数 / 单文件 markdown 字节数（UTF-8）/ 单批 markdown 原文合计字节数；
 * - 超限服务端返回 413 IMPORT_TOO_LARGE；前端在调用前用同一组常量预检直接提示。
 */
export const IMPORT_MAX_FILES_PER_BATCH = 50;
export const IMPORT_MAX_FILE_BYTES = 1024 * 1024;
export const IMPORT_MAX_BATCH_BYTES = 10 * 1024 * 1024;
/**
 * preview-batch 路由的 content-length 粗防线：JSON 转义后 body 约为 markdown 原文
 * 1.5–2 倍，在进入 parseBody（整包进内存）之前按 content-length 拦截（约 30MB），
 * 超出直接 413，不读 body。精确限额（按原文字节合计）仍由服务层校验。
 */
export const IMPORT_BATCH_BODY_LIMIT = 30 * 1024 * 1024;

/**
 * POST /api/teacher/import/preview 请求体。
 * markdown 为 v2 DSL 文档原文；filename 仅用于 imports 留档与前端展示，不参与解析。
 * T2A.3 扩展（D17/D18）：folderId = 目标文件夹（null / 缺省 = 未归类，不再自动创建
 * 「默认课程」）；sourcePath = 批量导入时的相对路径（单文件粘贴无路径，可缺省）。
 */
export const importPreviewRequestSchema = z.object({
  markdown: z.string().min(1, "markdown 不能为空"),
  filename: z.string().min(1, "filename 不能为空"),
  /** 目标文件夹（library_folders.id）；null / 缺省 = 未归类 */
  folderId: z.uuid("folderId 必须是 UUID 格式").nullable().optional(),
  /** 批量导入的文件相对路径（如 "chapter1/练习.md"）；粘贴内容无路径 */
  sourcePath: z.string().max(512, "sourcePath 过长").optional(),
});

/**
 * POST /api/teacher/import/commit 请求体。
 * T2A.3 扩展（D17）：
 * - folderId：目标文件夹（优先级最高；null = 未归类）；
 * - folderName：无 folderId 时按名称查找/新建文件夹（「按子目录自动建文件夹」与
 *   「就地新建」场景；同名已存在则复用）；
 * - courseId：兼容旧参数（T2A.1 语义：内容进课程同名文件夹 + 追加课程目录条目，
 *   讲义可见、单元隐藏）；不再自动创建「默认课程」（D23-7）；
 * - batchId：批量导入的批次 id（前端 crypto.randomUUID 生成，逐文件 commit 携带）；
 * - addToCourse：「同时加入课程」快捷项（追加目录条目，归属仍在资源库）；
 * - 三者均缺省时导入落「未归类」，不创建任何课程。
 */
export const importCommitRequestSchema = importPreviewRequestSchema.extend({
  courseId: z.uuid("courseId 必须是 UUID 格式").optional(),
  folderId: z.uuid("folderId 必须是 UUID 格式").nullable().optional(),
  /** 无 folderId 时按名称查找/新建的目标文件夹名 */
  folderName: z
    .string()
    .trim()
    .min(1, "folderName 不能为空")
    .max(100)
    .optional(),
  /** 批量导入批次 id（GET /api/teacher/import/batches/:batchId 回看） */
  batchId: z.uuid("batchId 必须是 UUID 格式").optional(),
  /** 同时加入课程（D17 快捷项）：追加目录条目到末尾，visible 对讲义与单元统一生效 */
  addToCourse: z
    .object({
      courseId: z.uuid("courseId 必须是 UUID 格式"),
      visible: z.boolean(),
    })
    .optional(),
});

/** 预览摘要（commit 响应不含摘要，报告见 importCommitDataSchema） */
export const importSummarySchema = z.object({
  /** 练习单元数 */
  unitCount: z.number().int().min(0),
  /** 讲义篇数（H1 切分） */
  lectureCount: z.number().int().min(0),
  /** 题目总数 */
  questionCount: z.number().int().min(0),
  /** 题型 → 题数（键为 questionTypeSchema 取值；只含出现过的题型） */
  typeDistribution: z.record(z.string(), z.number().int().min(0)),
});

// ---------- T2A.3：动作清单（D19）与预览 warning（D18/D19） ----------

/** 导入动作类型（D19 动作清单） */
export const importActionKindSchema = z.enum([
  /** 新增单元 */
  "createUnit",
  /** 更新单元（同 unit id 命中，保留其原文件夹，D18） */
  "updateUnit",
  /** 新增讲义 */
  "createLecture",
  /** 更新讲义（同 (目标文件夹, 标题) 命中，替换 markdown，D18） */
  "updateLecture",
]);

/** 更新单元的题目细分（D19）：新增题 / 更新题（version+1）/ 保留题（文件中未出现） */
export const importUnitQuestionPlanSchema = z.object({
  /** 文件中出现、库中不存在的题目数（version=1 插入） */
  inserted: z.number().int().min(0),
  /** 文件中出现、库中已存在（含回收站软删，将恢复）的题目数（version+1） */
  updated: z.number().int().min(0),
  /** 库中已有未删除题目中未出现在文件里的数量（保留不删，D18） */
  kept: z.number().int().min(0),
});

/** 预览动作清单条目（D19：预览必须展示「将发生什么」） */
export const importActionSchema = z.object({
  kind: importActionKindSchema,
  /** 资源标题（单元 title / 讲义 H1 标题） */
  title: z.string().min(1),
  /** 单元 id（来自 DSL）；讲义动作为 null */
  unitId: z.string().nullable(),
  /** 动作对象所在（更新）/ 将进入（新增）的文件夹名；null = 未归类 */
  folderName: z.string().nullable(),
  /** 命中回收站中的资源：将自动恢复并更新（D18） */
  restore: z.boolean(),
  /** 更新单元的题目细分（仅 updateUnit 提供；createUnit 全部为新增题，不细分） */
  questions: importUnitQuestionPlanSchema.optional(),
});

/** 预览 warning 的结构化编码（D18/D19；message 为可直接展示的中文） */
export const importPreviewWarningSchema = z.object({
  code: z.enum([
    /** 其他文件夹已有同名讲义，确认不是重复导入（D18 讲义） */
    "DUPLICATE_LECTURE_TITLE_IN_OTHER_FOLDER",
    /** 文件中未出现的 N 道已有题目将保留（D18 题目） */
    "KEPT_QUESTIONS",
    /** 被更新的单元正被 N 个未截止作业使用（D19） */
    "UNIT_USED_BY_OPEN_ASSIGNMENTS",
    /**
     * 配套讲义（frontmatter lecture）在目标文件夹与本文件解析产出中都无同名讲义：
     * 练习将暂不关联讲义（内容模型与导入规范化方案 §4，warning 级不阻断导入）
     */
    "LECTURE_LINK_UNRESOLVED",
  ]),
  message: z.string().min(1),
});

/** POST /api/teacher/import/preview 响应 data：摘要 + 全部 lint issues（不写库） */
export const importPreviewDataSchema = z.object({
  summary: importSummarySchema,
  /** lintDocument 的全部 issue（error + warning） */
  issues: z.array(lintIssueSchema),
  /** 动作清单（D19；T2A.3 起提供，兼容旧消费者解析时缺省为空数组） */
  actions: z.array(importActionSchema).default([]),
  /** 导入 warning（D18/D19；不含 lint warning——那些在 issues 里） */
  warnings: z.array(importPreviewWarningSchema).default([]),
});

/** 单元导入结果：id 来自 DSL；inserted/updated 互斥（按 unit.id 全局匹配） */
export const importUnitReportSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  inserted: z.boolean(),
  updated: z.boolean(),
});

/** 讲义导入结果：按 (courseId, title) 匹配替换 markdown；id 为导入时生成的 UUID */
export const importLectureReportSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  inserted: z.boolean(),
  updated: z.boolean(),
});

/** 题目导入统计：inserted = 新 id 插入（version=1）；updated = id 已存在更新（version+1） */
export const importQuestionsReportSchema = z.object({
  inserted: z.number().int().min(0),
  updated: z.number().int().min(0),
});

/**
 * POST /api/teacher/import/commit 响应 data：导入统计报告。
 * T2A.3：courseId 语义变更（D17 导入只进资源库）——兼容路径（显式 courseId）返回该课程，
 * addToCourse 返回目标课程，其余为 null（不再自动创建「默认课程」）；新增 folderId
 * （实际落库的目标文件夹，null = 未归类）。
 */
export const importCommitDataSchema = z.object({
  /** imports 留档行 id（crypto.randomUUID，§0.3） */
  importId: z.uuid(),
  /** 关联课程 id：兼容路径 = courseId；addToCourse = 目标课程；其余 null */
  courseId: z.uuid().nullable(),
  /** 实际落库的目标文件夹 id；null = 未归类 */
  folderId: z.uuid().nullable(),
  units: z.array(importUnitReportSchema),
  lectures: z.array(importLectureReportSchema),
  questions: importQuestionsReportSchema,
});

/**
 * 内容相关错误码（UPPER_SNAKE_CODE 固定子集）：
 * - LINT_ERROR：commit / 单条编辑遇 error 级 issue，拒绝写入（422）；
 * - COURSE_NOT_FOUND：请求携带的 courseId 不存在（404）；
 * - QUESTION_NOT_FOUND：题目不存在（含软删后按不存在处理）（404）；
 * - LECTURE_NOT_FOUND：讲义不存在（404）；
 * - UNIT_NOT_FOUND：单元不存在（404）；
 * - ID_IMMUTABLE：单题编辑解析出的 id 与原 id 不一致（422，id 不可变）；
 * - COURSE_NOT_EMPTY：T2A.4 起课程删除改按 D4 语义（有作答或作业 409
 *   COURSE_HAS_ATTEMPTS），本码不再由 DELETE /courses/:id 产生，保留枚举值兼容旧契约消费者；
 * - COURSE_HAS_ATTEMPTS：课程有作答记录或按课程布置的作业时拒绝删除（409，D4；提示改用归档）；
 * - FOLDER_NOT_FOUND：导入目标文件夹不存在（404，T2A.3；与 library-api 同码同义）；
 * - IMPORT_TOO_LARGE：批量导入超规模上限（413，D20；也用于 preview-batch 的
 *   content-length 粗防线）。
 */
export const contentErrorCodeSchema = z.enum([
  "LINT_ERROR",
  "COURSE_NOT_FOUND",
  "QUESTION_NOT_FOUND",
  "LECTURE_NOT_FOUND",
  "UNIT_NOT_FOUND",
  "ID_IMMUTABLE",
  "COURSE_NOT_EMPTY",
  "COURSE_HAS_ATTEMPTS",
  "FOLDER_NOT_FOUND",
  "IMPORT_TOO_LARGE",
]);

/**
 * commit 的 LINT_ERROR 响应体：统一错误壳 + _issues 附加字段（error 级 issue 列表，
 * 供前端在编辑器对应行标红）。是 apiErrSchema 的超集（附加字段不破坏统一壳解析）。
 */
export const importLintErrorBodySchema = z.object({
  ok: z.literal(false),
  error: z.literal("LINT_ERROR"),
  message: z.string().min(1),
  /** error 级 issue（至少 1 条，否则不会返回该壳） */
  _issues: z.array(lintIssueSchema).min(1),
});

/** 携带预览数据的成功响应壳 */
export const importPreviewOkSchema = apiOkExtend(importPreviewDataSchema);

/** 携带导入报告的成功响应壳 */
export const importCommitOkSchema = apiOkExtend(importCommitDataSchema);

// ---------- GET /api/teacher/content：内容树（T1.11） ----------

/**
 * 内容树中的题目摘要（单元展开行）：只含列表展示必需的字段，不含题干/答案/详解。
 * 教师端接口无泄露约束，但摘要保持最小化（完整内容 T1.12 编辑抽屉按 id 取）。
 */
export const contentTreeQuestionSchema = z.object({
  /** 题目 id（来自 DSL；缺省为 `单元slug-序号`） */
  id: z.string().min(1),
  type: questionTypeSchema,
  /** 难度 1–5 */
  difficulty: z.number().int().min(1).max(5),
  /** 考点名列表（导入时经 knowledge_points 归一） */
  knowledge: z.array(z.string().min(1)),
  /** 内容版本：新插入 1，同 id 再导入 +1 */
  version: z.number().int().min(1),
});

/** 内容树中的讲义节点：标题 + 更新时间（讲义无题目，不挂题目摘要） */
export const contentTreeLectureSchema = z.object({
  /** 讲义 id（导入时生成的 UUID） */
  id: z.uuid(),
  title: z.string().min(1),
  /** 最近更新时间：UTC ISO 字符串 */
  updatedAt: z.string().min(1),
});

/** 内容树中的练习单元节点：展开显示题目摘要表 */
export const contentTreeUnitSchema = z.object({
  /** 单元 id（来自 DSL） */
  id: z.string().min(1),
  title: z.string().min(1),
  /** 主题；未标注为 null（数据库列可空，与 v1 UNIT 第三段语义一致） */
  topic: z.string().nullable(),
  /** 最近更新时间：UTC ISO 字符串 */
  updatedAt: z.string().min(1),
  /** 单元内题目摘要（软删题目不出现，T1.12 起删除即从列表消失） */
  questions: z.array(contentTreeQuestionSchema),
});

/** 内容树中的课程节点：教师端内容页的顶层分组 */
export const contentTreeCourseSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  /** 课程下的讲义列表（order 升序） */
  lectures: z.array(contentTreeLectureSchema),
  /** 课程下的练习单元列表（order 升序，题目按单元内题序） */
  units: z.array(contentTreeUnitSchema),
});

/** GET /api/teacher/content 响应 data：课程 → 讲义/单元 → 题目摘要的树状结构 */
export const contentTreeSchema = z.object({
  courses: z.array(contentTreeCourseSchema),
});

/** 携带内容树的成功响应壳 */
export const contentTreeOkSchema = apiOkExtend(contentTreeSchema);

// ---------- T1.12：单条编辑 / 删除 / 排序 / 课程 CRUD ----------

/**
 * GET /api/teacher/questions/:id 响应 data：编辑抽屉按 id 取题目完整内容。
 * sourceMd 为该题原始 Markdown 片段（::::question 容器），编辑提交即此格式；
 * order/unitId 供前端本地 lint 复现缺省 id（questionStartNumber = order + 1）。
 */
export const questionDetailSchema = z.object({
  /** 题目 id（来自 DSL，编辑保持不变） */
  id: z.string().min(1),
  /** 所属单元 id（编辑不改变归属） */
  unitId: z.string().min(1),
  /** 单元内题序（0 起；单题重新解析的 questionStartNumber = order + 1） */
  order: z.number().int().min(0),
  type: questionTypeSchema,
  /** 难度 1–5 */
  difficulty: z.number().int().min(1).max(5),
  /** 考点名列表（knowledge_points 归一后的关联结果） */
  knowledge: z.array(z.string().min(1)),
  /** 原始 Markdown 片段（::::question 容器，含题干/选项/提示/详解） */
  sourceMd: z.string().min(1),
  /** 内容版本 */
  version: z.number().int().min(1),
});

/** PUT /api/teacher/questions/:id 请求体：提交该题 sourceMd 重新解析（原文是真相，§5.1.1(4)） */
export const questionUpdateRequestSchema = z.object({
  sourceMd: z.string().min(1, "sourceMd 不能为空"),
});

/**
 * PUT /api/teacher/questions/:id 响应 data：编辑结果。
 * id/version 供前端断言「id 不变、version+1」；issues 为该题重新解析 + lint 的全部
 * issue（能到达本响应时 error 级必为 0，warning 可携带成功），行号为 sourceMd 片段坐标。
 */
export const questionUpdateDataSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(2),
  type: questionTypeSchema,
  difficulty: z.number().int().min(1).max(5),
  knowledge: z.array(z.string().min(1)),
  issues: z.array(lintIssueSchema),
});

/** GET /api/teacher/lectures/:id 响应 data：编辑抽屉取讲义原文（markdown 含 H1 标题行） */
export const lectureDetailSchema = z.object({
  /** 讲义 id（数据库 uuid，编辑保持不变） */
  id: z.uuid(),
  title: z.string().min(1),
  /** 讲义原始 Markdown（含 H1 标题行，整篇编辑提交） */
  markdown: z.string().min(1),
  /** 最近更新时间：UTC ISO 字符串 */
  updatedAt: z.string().min(1),
});

/** PUT /api/teacher/lectures/:id 请求体：整篇讲义 markdown，title 从 H1 重取 */
export const lectureUpdateRequestSchema = z.object({
  markdown: z.string().min(1, "markdown 不能为空"),
});

/** PUT /api/teacher/lectures/:id 响应 data */
export const lectureUpdateDataSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  /** 最近更新时间：UTC ISO 字符串 */
  updatedAt: z.string().min(1),
});

/** POST /api/teacher/reorder 请求体：ids 为该 kind 下本次排序作用域内实体的完整新顺序 */
export const reorderKindSchema = z.enum([
  "question",
  "lecture",
  "unit",
  "course",
]);

export const reorderRequestSchema = z.object({
  kind: reorderKindSchema,
  /** 完整新顺序（order 按数组下标 0 起重写）；题目传其所属单元内的题目 id */
  ids: z
    .array(z.string().min(1, "id 不能为空"))
    .min(1, "ids 不能为空")
    .refine((ids) => new Set(ids).size === ids.length, "ids 不能有重复"),
});

/** 可排序实体的 kind（题目/讲义/单元/课程） */
export type ReorderKind = z.infer<typeof reorderKindSchema>;

/**
 * POST /api/teacher/courses 请求体。title 即课程名（映射 courses.title 列）；
 * T2A.4 起可选 description（课程编辑页新建对话框填写，缺省 null）。
 */
export const courseCreateRequestSchema = z.object({
  title: z.string().trim().min(1, "课程名不能为空"),
  description: z.string().trim().max(500, "课程简介最多 500 个字符").optional(),
});

/**
 * PATCH /api/teacher/courses/:id 请求体（字段缺省 = 不改）。
 * T2A.4 扩展（清单口径 name）：name 与 title 同义（name 为 Phase 2A 术语口径，
 * title 兼容旧调用方），二者只能提供一个；description 显式 null = 清空简介；
 * archived：true 归档（archivedAt 置当前时间）、false 恢复（置 null），D4。
 */
export const courseUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1, "课程名不能为空").optional(),
    name: z.string().trim().min(1, "课程名不能为空").optional(),
    description: z
      .string()
      .trim()
      .max(500, "课程简介最多 500 个字符")
      .nullable()
      .optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (body) => !(body.title !== undefined && body.name !== undefined),
    "title 与 name 只能提供一个（两者同义）",
  );

/**
 * 课程 CRUD（创建/更新）响应 data。
 * T2A.4 起增加 description / archived / archivedAt（新增字段，旧消费者不受影响；
 * 课程名仍用 title 字段名——与本组既有契约一致，course-api.ts 的列表/详情用 name）。
 */
export const courseDataSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  /** 同级排序（小在前） */
  order: z.number().int().min(0),
  description: z.string().nullable(),
  /** 是否已归档（archivedAt 非空） */
  archived: z.boolean(),
  /** 归档时间；未归档为 null */
  archivedAt: z.string().nullable(),
});

// ---------- 学生端：讲义（T2.3；T2A.5 切换 D5 可见性） ----------

/**
 * GET /api/student/lectures 响应 data 中的讲义摘要。
 * 只含公开元信息（标题/主题/更新时间）。T2A.5 起按 D5 过滤：该生在所在全部课程中
 * 可见讲义条目的并集（同一讲义出现在多个课程，去重列表只出现一次，但各课程分组中
 * 各自出现）。topic 取**对该生可见**的配套单元（units.lectureId 指向本讲义且在
 * 该生某门可见课程中有可见单元条目）中排序最靠前者的主题——隐藏单元不贡献 topic
 * （隐藏条目零信息）；无可见配套单元或未标注主题时为 null。
 */
export const studentLectureSummarySchema = z.object({
  /** 讲义 id（导入时生成的 UUID） */
  id: z.uuid(),
  /** 讲义标题（H1 标题文本） */
  title: z.string().min(1),
  /** 可见配套单元的主题；无可见配套或未标注为 null */
  topic: z.string().nullable(),
  /** 最近更新时间：UTC ISO 字符串 */
  updatedAt: z.string().min(1),
});

/**
 * 讲义列表的课程分组（T2A.5，D5）：
 * 该生为成员且未归档、其中该生此刻可见讲义 ≥1 篇的课程各一组（组内按目录条目
 * order 排序）。同一讲义在多个分组中重复出现是设计行为（分组视图各自完整）；
 * 跨课程去重由 lectures 字段承担（并集只列一次）。
 */
export const studentLectureCourseGroupSchema = z.object({
  courseId: z.uuid(),
  courseName: z.string().min(1),
  /** 该课程可见讲义摘要（目录条目顺序） */
  lectures: z.array(studentLectureSummarySchema),
});

/**
 * GET /api/student/lectures 响应 data（T2A.5 双视图）：
 * - lectures：可见讲义**去重并集**（同一讲义多课只列一次；排序取最优位置——
 *   course.order → 首个可见条目 order，兜底讲义 title）；
 * - courses：按课程分组视图（「我的课程页/讲义列表页」分组渲染用；只含有可见
 *   讲义的课程组，按 course.order 升序）。
 */
export const studentLectureListDataSchema = z.object({
  /** 去重并集（跨课程只出现一次） */
  lectures: z.array(studentLectureSummarySchema),
  /** 按课程分组（同一讲义可在多个课程组出现） */
  courses: z.array(studentLectureCourseGroupSchema),
});

/** GET /api/student/lectures/:id 查询参数：课程上下文（D8 配套练习按课程计算）。缺省 = 取第一个可见该讲义的课程 */
export const studentLectureDetailQuerySchema = z.object({
  courseId: z.uuid("courseId 必须是 UUID 格式").optional(),
});

/**
 * 学生阅读讲义页底部的「本课配套练习」条目（D8）：units.lectureId 指向该讲义、
 * 且**在所选课程的目录中对该生可见**的单元（隐藏/未到发布时间/已删除的配套单元
 * 不出现——零信息）。questionCount 为该单元未删除题目数；作答入口 T2A.6 开放
 * （前端显示「n 题 · 即将开放」）。
 */
export const studentLectureCompanionUnitSchema = z.object({
  /** 单元 id（来自 DSL，非 UUID） */
  id: z.string().min(1),
  /** 单元标题 */
  title: z.string().min(1),
  /** 未删除题目数 */
  questionCount: z.number().int().min(0),
});

/**
 * GET /api/student/lectures/:id 响应 data：讲义全文 markdown（含 H1 标题行）+
 * 课程上下文与配套练习（T2A.5，D5/D8）。
 *
 * 讲义全量下发是设计如此（§5.3）：讲义中的 :::solution 是讲解内容而非题目答案，
 * 学生端应见（默认折叠、点开查看）。但本响应**不得**附带任何 questions 表字段
 * （answers/solutionMd/hintsJson/stemMd/optionsJson 等，AGENTS.md 第 3 条）——
 * 讲义 markdown 本身允许含指令语法文本。
 *
 * 访问判定（D22）：讲义只经课程可见（不再有全量讲义）——指定 courseId 时非成员/
 * 课程归档 403 COURSE_ACCESS_DENIED，条目隐藏/未到发布/已删除 404 NOT_FOUND；
 * 未指定 courseId 时该生在任何课程中都看不到该讲义 → 404 NOT_FOUND（不暴露存在性）。
 * courseId/courseName 为该次访问的课程上下文（缺省时取第一个可见该讲义的课程，
 * 排序 course.order → 条目 order）。
 */
export const studentLectureDetailSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  /** 讲义原始 Markdown（含 H1 标题行；前端用 <RichMarkdown> 渲染） */
  markdown: z.string().min(1),
  /** 最近更新时间：UTC ISO 字符串 */
  updatedAt: z.string().min(1),
  /** 本次访问的课程上下文（可见该讲义的课程之一） */
  courseId: z.uuid(),
  courseName: z.string().min(1),
  /** 本课配套练习（D8：同课程可见的配套单元；空数组 = 无可见配套） */
  companionUnits: z.array(studentLectureCompanionUnitSchema),
});

/** 携带学生讲义列表/详情的成功响应壳 */
export const studentLectureListOkSchema = apiOkExtend(
  studentLectureListDataSchema,
);
export const studentLectureDetailOkSchema = apiOkExtend(
  studentLectureDetailSchema,
);

// ---------- T2A.3：批量导入（D20） ----------

/** preview-batch 的单文件输入：path 为相对路径（文件夹选择时含子目录） */
export const importBatchFileInputSchema = z.object({
  /** 文件相对路径（如 "chapter1/练习.md"）；同一批次内不应重复 */
  path: z.string().min(1, "path 不能为空").max(512, "path 过长"),
  markdown: z.string().min(1, "markdown 不能为空"),
});

/**
 * POST /api/teacher/import/preview-batch 请求体（D20）：
 * - folderId：全批默认目标文件夹（null / 缺省 = 未归类）；
 * - autoFolderBySubdir：按文件直接父目录名自动建/复用文件夹（根目录文件仍用 folderId）；
 * - files：≤50 个、单文件 ≤1MB、合计 ≤10MB（超限 413 IMPORT_TOO_LARGE，按原始
 *   markdown UTF-8 字节判定，不以 JSON body 体积为准；文件数上限由服务层校验，
 *   避免 zod max 报 400 掩盖 413 语义）。
 */
export const importPreviewBatchRequestSchema = z.object({
  folderId: z.uuid("folderId 必须是 UUID 格式").nullable().optional(),
  autoFolderBySubdir: z.boolean(),
  files: z.array(importBatchFileInputSchema).min(1, "files 不能为空"),
});

/** 批内跨文件冲突（D20：视为 error，涉及文件都标红） */
export const importBatchConflictSchema = z.object({
  code: z.enum([
    /** 两个文件定义了同一 unit id */
    "DUPLICATE_UNIT_ID",
    /** 两个文件在同一目标文件夹下定义了同名讲义 */
    "DUPLICATE_LECTURE_TITLE",
  ]),
  /** 中文说明（含冲突对象，可直接展示） */
  message: z.string().min(1),
  /** 与本文件冲突的另一个文件的相对路径 */
  otherPath: z.string().min(1),
});

/** preview-batch 的单文件条目：目标文件夹 + 单文件预览 + 跨文件冲突 */
export const importBatchFilePreviewSchema = z.object({
  /** 文件相对路径（与请求一一对应） */
  path: z.string().min(1),
  /** 该文件的目标文件夹 id；null = 未归类 */
  folderId: z.uuid().nullable(),
  /** 该文件的目标文件夹名；null = 未归类（autoFolderBySubdir 命中子目录名） */
  folderName: z.string().nullable(),
  /** 目标文件夹尚不存在、commit 时将按 folderName 新建（D20 复用同名） */
  folderToCreate: z.boolean(),
  /** 单文件预览（version/摘要/issues/动作清单/警告——与单文件 preview 同构） */
  preview: importPreviewDataSchema,
  /** 本文件涉及的跨文件冲突（空 = 无） */
  conflicts: z.array(importBatchConflictSchema),
  /** lint error 或跨文件冲突非空 → 前端禁选/标红、提交时自动跳过 */
  hasError: z.boolean(),
});

/** POST /api/teacher/import/preview-batch 响应 data（文件顺序与请求一致） */
export const importPreviewBatchDataSchema = z.object({
  files: z.array(importBatchFilePreviewSchema),
});

// ---------- T2A.3：批次回看（GET /api/teacher/import/batches/:batchId） ----------

/** 批次内单个文件的导入留档（imports 行 + 解析后的报告） */
export const importBatchFileRecordSchema = z.object({
  /** imports 留档行 id（即单文件 commit 响应的 importId） */
  importId: z.uuid(),
  /** 导入时的文件名 */
  filename: z.string().min(1),
  /** 批量导入的相对路径；单文件导入为 null */
  sourcePath: z.string().nullable(),
  /** 实际落库的目标文件夹；null = 未归类 */
  folderId: z.uuid().nullable(),
  /** 导入时间：UTC ISO 字符串 */
  createdAt: z.string().min(1),
  /** 该文件 commit 的统计报告（reportJson 反序列化） */
  report: importCommitDataSchema,
});

/**
 * GET /api/teacher/import/batches/:batchId 响应 data：批量提交逐文件 commit 后的
 * 服务端记录回看。batchId 无任何成功记录时返回空 files（200，不报 404——全部
 * 文件被跳过是合法批次）。
 */
export const importBatchDataSchema = z.object({
  batchId: z.uuid(),
  /** 按 createdAt 升序 */
  files: z.array(importBatchFileRecordSchema),
});

/** 携带批量预览数据的成功响应壳 */
export const importPreviewBatchOkSchema = apiOkExtend(
  importPreviewBatchDataSchema,
);

/** 携带批次回看数据的成功响应壳 */
export const importBatchOkSchema = apiOkExtend(importBatchDataSchema);

export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;
export type ImportCommitRequest = z.infer<typeof importCommitRequestSchema>;
export type ImportSummary = z.infer<typeof importSummarySchema>;
export type ImportPreviewData = z.infer<typeof importPreviewDataSchema>;
export type ImportActionKind = z.infer<typeof importActionKindSchema>;
export type ImportAction = z.infer<typeof importActionSchema>;
export type ImportUnitQuestionPlan = z.infer<
  typeof importUnitQuestionPlanSchema
>;
export type ImportPreviewWarning = z.infer<typeof importPreviewWarningSchema>;
export type ImportUnitReport = z.infer<typeof importUnitReportSchema>;
export type ImportLectureReport = z.infer<typeof importLectureReportSchema>;
export type ImportQuestionsReport = z.infer<typeof importQuestionsReportSchema>;
export type ImportCommitData = z.infer<typeof importCommitDataSchema>;
export type ImportBatchFileInput = z.infer<typeof importBatchFileInputSchema>;
export type ImportPreviewBatchRequest = z.infer<
  typeof importPreviewBatchRequestSchema
>;
export type ImportBatchConflict = z.infer<typeof importBatchConflictSchema>;
export type ImportBatchFilePreview = z.infer<
  typeof importBatchFilePreviewSchema
>;
export type ImportPreviewBatchData = z.infer<
  typeof importPreviewBatchDataSchema
>;
export type ImportBatchFileRecord = z.infer<typeof importBatchFileRecordSchema>;
export type ImportBatchData = z.infer<typeof importBatchDataSchema>;
export type ContentErrorCode = z.infer<typeof contentErrorCodeSchema>;
export type ContentTreeQuestion = z.infer<typeof contentTreeQuestionSchema>;
export type ContentTreeLecture = z.infer<typeof contentTreeLectureSchema>;
export type ContentTreeUnit = z.infer<typeof contentTreeUnitSchema>;
export type ContentTreeCourse = z.infer<typeof contentTreeCourseSchema>;
export type ContentTree = z.infer<typeof contentTreeSchema>;
export type QuestionDetail = z.infer<typeof questionDetailSchema>;
export type QuestionUpdateRequest = z.infer<typeof questionUpdateRequestSchema>;
export type QuestionUpdateData = z.infer<typeof questionUpdateDataSchema>;
export type LectureDetail = z.infer<typeof lectureDetailSchema>;
export type LectureUpdateRequest = z.infer<typeof lectureUpdateRequestSchema>;
export type LectureUpdateData = z.infer<typeof lectureUpdateDataSchema>;
export type ReorderRequest = z.infer<typeof reorderRequestSchema>;
export type CourseCreateRequest = z.infer<typeof courseCreateRequestSchema>;
export type CourseUpdateRequest = z.infer<typeof courseUpdateRequestSchema>;
export type CourseData = z.infer<typeof courseDataSchema>;
export type StudentLectureSummary = z.infer<typeof studentLectureSummarySchema>;
export type StudentLectureCourseGroup = z.infer<
  typeof studentLectureCourseGroupSchema
>;
export type StudentLectureListData = z.infer<
  typeof studentLectureListDataSchema
>;
export type StudentLectureDetailQuery = z.infer<
  typeof studentLectureDetailQuerySchema
>;
export type StudentLectureCompanionUnit = z.infer<
  typeof studentLectureCompanionUnitSchema
>;
export type StudentLectureDetail = z.infer<typeof studentLectureDetailSchema>;
