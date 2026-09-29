import { z } from "zod";
import { questionTypeSchema } from "./content.ts";
import { contentTreeQuestionSchema } from "./content-api.ts";

/**
 * 资源库 API 契约（T2A.2 起为权威定义）：教师端资源库页面（讲义库 / 题库 / 回收站）
 * 与单元管理的请求体/响应 data、错误码。
 * 依据：docs/Phase2A改进任务清单.md §5 T2A.2、§2 D2（文件夹）、D3（软删+回收站+purge 条件）、
 * D8（配套讲义）、D16（资源删除不影响作业）；§4 教师端通用使用约定。
 *
 * 约定（与 content-api.ts 一致）：
 * - 本文件只定义请求体与 data 部分；响应壳 { ok, data } / { ok, error, message } 由
 *   index.ts 统一描述，此处仅用局部 helper 具体化成功壳；
 * - 全部为教师端接口（requireTeacher），响应含答案/详解属正常（教师侧，无泄露约束）；
 * - 「未归类」= folderId NULL，不是文件夹行（D2）；folderId 查询参数用 "none" 表示未归类。
 * - export.md 接口为文件直出（text/markdown 附件），不走 JSON 统一壳（同 /api/public/spec）。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 文件夹（D2：一级、不可嵌套；「未归类」= folderId NULL） ----------

/** 文件夹数据（GET /api/teacher/library/folders 列表项，含资源计数） */
export const libraryFolderSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  /** 同级排序（小在前） */
  order: z.number().int().min(0),
  /** 文件夹内讲义数（仅统计未删除） */
  lectureCount: z.number().int().min(0),
  /** 文件夹内单元数（仅统计未删除） */
  unitCount: z.number().int().min(0),
  createdAt: z.string().min(1),
});

/** GET /api/teacher/library/folders 响应 data（order 升序；「未归类」不是行，由前端固定渲染） */
export const libraryFolderListSchema = z.object({
  folders: z.array(libraryFolderSchema),
});

/** POST /api/teacher/library/folders 请求体 */
export const libraryFolderCreateSchema = z.object({
  name: z.string().trim().min(1, "文件夹名不能为空"),
});

/** PATCH /api/teacher/library/folders/:id 请求体（改名） */
export const libraryFolderUpdateSchema = z.object({
  name: z.string().trim().min(1, "文件夹名不能为空"),
});

/** POST /api/teacher/library/folders/reorder 请求体：全部文件夹的完整新顺序 */
export const libraryFolderReorderSchema = z.object({
  ids: z
    .array(z.uuid("id 必须是 UUID 格式"))
    .min(1, "ids 不能为空")
    .refine((ids) => new Set(ids).size === ids.length, "ids 不能有重复"),
});

// ---------- 讲义库 / 题库列表 ----------

/**
 * 列表查询参数（GET /api/teacher/library/lectures、/units）：
 * - folderId：缺省 = 全部文件夹；"none" = 未归类（folderId NULL）；UUID = 指定文件夹；
 * - q：搜索词（标题 / 单元 id / topic / 考点；前端即时过滤为主，服务端同口径过滤兜底）；
 * - deleted："1" = 只列回收站（deletedAt 非空）；缺省 / "0" = 只列未删除。
 */
export const libraryListQuerySchema = z.object({
  folderId: z.string().optional(),
  q: z.string().optional(),
  deleted: z.enum(["0", "1"]).optional(),
});

export type LibraryListQuery = z.infer<typeof libraryListQuerySchema>;

/** 讲义库列表项：标题 + 归属 + 引用数（§4-4 状态一目了然） */
export const libraryLectureSummarySchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  /** 所属文件夹；NULL = 未归类 */
  folderId: z.uuid().nullable(),
  updatedAt: z.string().min(1),
  /** 软删时间；NULL = 未删除（回收站列表展示删除时间） */
  deletedAt: z.string().nullable(),
  /** 被课程目录引用的次数（course_items 命中数） */
  courseCount: z.number().int().min(0),
});

/** GET /api/teacher/library/lectures 响应 data */
export const libraryLectureListSchema = z.object({
  lectures: z.array(libraryLectureSummarySchema),
});

/** 题库列表项的题目摘要（与内容树同一形状，单元展开显示用） */
export const libraryUnitQuestionSchema = contentTreeQuestionSchema;

/** 题库列表项：题数、题型分布、考点、引用数、使用作业数（§4-3 找得到） */
export const libraryUnitSummarySchema = z.object({
  /** 单元 id（来自 DSL，全局唯一） */
  id: z.string().min(1),
  title: z.string().min(1),
  /** 主题；未标注为 null */
  topic: z.string().nullable(),
  folderId: z.uuid().nullable(),
  /** 配套讲义（D8）；无配套为 null */
  lectureId: z.uuid().nullable(),
  /** 配套讲义标题（按 lectureId 现值取；讲义行缺失为 null） */
  lectureTitle: z.string().nullable(),
  updatedAt: z.string().min(1),
  deletedAt: z.string().nullable(),
  /** 未删除题目数 */
  questionCount: z.number().int().min(0),
  /** 题型 → 题数（只含未删除题目出现过的题型） */
  typeDistribution: z.record(z.string(), z.number().int().min(0)),
  /** 单元内全部未删除题目的考点汇总（去重、按名排序） */
  knowledge: z.array(z.string().min(1)),
  /** 被课程目录引用的次数 */
  courseCount: z.number().int().min(0),
  /** 使用本单元的未删除作业数 */
  assignmentCount: z.number().int().min(0),
  /** 题目摘要（未删除题目按单元内题序；编辑抽屉 / 拖拽排序复用现有交互） */
  questions: z.array(libraryUnitQuestionSchema),
});

/** GET /api/teacher/library/units 响应 data */
export const libraryUnitListSchema = z.object({
  units: z.array(libraryUnitSummarySchema),
});

// ---------- 单元 / 讲义元数据编辑（T2A.2） ----------

/**
 * PATCH /api/teacher/units/:id 请求体：字段缺省 = 不改。
 * - topic / folderId / lectureId 显式 null = 清空（未归类 / 无配套讲义 / 无主题）；
 * - 重新导入同 id 单元会用文件内容覆盖标题与主题（页面有说明文案）。
 */
export const unitMetaUpdateSchema = z.object({
  title: z.string().trim().min(1, "单元标题不能为空").optional(),
  topic: z
    .string()
    .trim()
    .min(1, "主题不能为空（清空请传 null）")
    .nullable()
    .optional(),
  folderId: z.uuid("folderId 必须是 UUID 格式").nullable().optional(),
  lectureId: z.uuid("lectureId 必须是 UUID 格式").nullable().optional(),
});

/** PATCH /api/teacher/units/:id 响应 data：更新后的单元元数据 */
export const unitMetaDataSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  topic: z.string().nullable(),
  folderId: z.uuid().nullable(),
  lectureId: z.uuid().nullable(),
  updatedAt: z.string().min(1),
});

/**
 * PATCH /api/teacher/lectures/:id 请求体：移动文件夹（T2A.2）。
 * 讲义标题与 markdown 走现有 PUT /api/teacher/lectures/:id（整篇编辑，title 从 H1 重取），
 * 本接口只改归属，不触碰内容。
 */
export const lectureMetaUpdateSchema = z.object({
  folderId: z.uuid("folderId 必须是 UUID 格式").nullable().optional(),
});

/** PATCH /api/teacher/lectures/:id 响应 data */
export const lectureMetaDataSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  folderId: z.uuid().nullable(),
});

// ---------- 使用情况（D3 删除确认弹层 / purge 条件判断） ----------

/** 使用情况中的课程引用（条目级「当前对学生是否可见」） */
export const libraryUsageCourseSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  /** 条目此刻是否满足条目级可见（visible 且 publishAt 已到） */
  visible: z.boolean(),
});

/** 使用情况中的作业引用（未删除作业） */
export const libraryUsageAssignmentSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  /** 截止时间；未设置为 null */
  dueAt: z.string().nullable(),
});

/** GET /api/teacher/units/:id/usage、/api/teacher/lectures/:id/usage 响应 data */
export const libraryUsageSchema = z.object({
  courses: z.array(libraryUsageCourseSchema),
  assignments: z.array(libraryUsageAssignmentSchema),
  /** 关联作答数（单元 = 直接统计；讲义 = 经配套单元保守合计） */
  attemptCount: z.number().int().min(0),
});

// ---------- 批量操作（§4-2） ----------

/** 批量动作：移动到文件夹 / 软删 / 从回收站恢复 / 加入课程 */
export const libraryBatchActionSchema = z.enum([
  "move",
  "delete",
  "restore",
  "addToCourse",
]);

/** 批量资源类型 */
export const libraryBatchKindSchema = z.enum(["lecture", "unit"]);

/**
 * POST /api/teacher/library/batch 请求体：
 * - move：folderId 必填（null = 移入未归类）；
 * - delete / restore：无需附加参数；
 * - addToCourse：courseId 必填，visible 缺省 true；重复加入按跳过处理（不报错）。
 */
export const libraryBatchRequestSchema = z.object({
  action: libraryBatchActionSchema,
  kind: libraryBatchKindSchema,
  ids: z.array(z.string().min(1, "id 不能为空")).min(1, "ids 不能为空"),
  /** move 目标文件夹；null = 未归类 */
  folderId: z.uuid("folderId 必须是 UUID 格式").nullable().optional(),
  /** addToCourse 目标课程 */
  courseId: z.uuid("courseId 必须是 UUID 格式").optional(),
  /** addToCourse 添加后是否对学生可见（缺省 true，D6） */
  visible: z.boolean().optional(),
});

/** 批量操作的单条结果（部分失败逐条返回，不中断其余） */
export const libraryBatchItemResultSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  /** true = 该条被跳过（如 addToCourse 时资源已在本课程） */
  skipped: z.boolean().optional(),
  /** ok=false 时的错误码（如 UNIT_NOT_FOUND） */
  error: z.string().min(1).optional(),
  /** 中文说明（跳过原因 / 失败原因） */
  message: z.string().min(1).optional(),
});

/** POST /api/teacher/library/batch 响应 data */
export const libraryBatchDataSchema = z.object({
  results: z.array(libraryBatchItemResultSchema),
});

// ---------- 导出（文件直出，非 JSON 壳；此处只固化文件名与内容约定） ----------

/**
 * GET /api/teacher/units/:id/export.md、/api/teacher/lectures/:id/export.md：
 * 响应为 text/markdown 附件（Content-Disposition: attachment; filename*=UTF-8''…），
 * 可原样重新导入（import preview 0 error）：
 * - 单元 = frontmatter（kind: practice、unit: <id>、lecture: <配套讲义标题>、topic）
 *   + 未删除各题 sourceMd 按题序拼接；已删题不导出（防止「导出→再导入」复活已删题），
 *   另有已删题时 frontmatter 后以 HTML 注释注明数量；
 * - 讲义 = kind: lecture frontmatter + markdown 原文。
 */
export const exportKindSchema = z.enum(["unit", "lecture"]);

// ---------- 错误码 ----------

/**
 * 资源库相关错误码（UPPER_SNAKE_CODE 固定子集）：
 * - FOLDER_NOT_FOUND：文件夹不存在（404）；
 * - FOLDER_NAME_EXISTS：同名文件夹已存在（409，应用层校验）；
 * - UNIT_NOT_FOUND / LECTURE_NOT_FOUND：单元 / 讲义不存在（404）；
 * - COURSE_NOT_FOUND：addToCourse 的 courseId 不存在（404）；
 * - RESOURCE_IN_USE：彻底删除被拒——存在作答记录或作业引用（409，D3）。
 */
export const libraryErrorCodeSchema = z.enum([
  "FOLDER_NOT_FOUND",
  "FOLDER_NAME_EXISTS",
  "UNIT_NOT_FOUND",
  "LECTURE_NOT_FOUND",
  "COURSE_NOT_FOUND",
  "RESOURCE_IN_USE",
]);

/** 题型分布的键约束（与 questionTypeSchema 取值一致，供服务端输出自检复用） */
export const libraryTypeDistributionKeySchema = questionTypeSchema;

// ---------- 成功响应壳 ----------

export const libraryFolderListOkSchema = apiOkExtend(libraryFolderListSchema);
export const libraryFolderOkSchema = apiOkExtend(libraryFolderSchema);
export const libraryLectureListOkSchema = apiOkExtend(libraryLectureListSchema);
export const libraryUnitListOkSchema = apiOkExtend(libraryUnitListSchema);
export const unitMetaOkSchema = apiOkExtend(unitMetaDataSchema);
export const lectureMetaOkSchema = apiOkExtend(lectureMetaDataSchema);
export const libraryUsageOkSchema = apiOkExtend(libraryUsageSchema);
export const libraryBatchOkSchema = apiOkExtend(libraryBatchDataSchema);

export type LibraryFolder = z.infer<typeof libraryFolderSchema>;
export type LibraryFolderList = z.infer<typeof libraryFolderListSchema>;
export type LibraryFolderCreate = z.infer<typeof libraryFolderCreateSchema>;
export type LibraryFolderUpdate = z.infer<typeof libraryFolderUpdateSchema>;
export type LibraryFolderReorder = z.infer<typeof libraryFolderReorderSchema>;
export type LibraryLectureSummary = z.infer<typeof libraryLectureSummarySchema>;
export type LibraryLectureList = z.infer<typeof libraryLectureListSchema>;
export type LibraryUnitQuestion = z.infer<typeof libraryUnitQuestionSchema>;
export type LibraryUnitSummary = z.infer<typeof libraryUnitSummarySchema>;
export type LibraryUnitList = z.infer<typeof libraryUnitListSchema>;
export type UnitMetaUpdate = z.infer<typeof unitMetaUpdateSchema>;
export type UnitMetaData = z.infer<typeof unitMetaDataSchema>;
export type LectureMetaUpdate = z.infer<typeof lectureMetaUpdateSchema>;
export type LectureMetaData = z.infer<typeof lectureMetaDataSchema>;
export type LibraryUsage = z.infer<typeof libraryUsageSchema>;
export type LibraryBatchRequest = z.infer<typeof libraryBatchRequestSchema>;
export type LibraryBatchData = z.infer<typeof libraryBatchDataSchema>;
export type LibraryErrorCode = z.infer<typeof libraryErrorCodeSchema>;
