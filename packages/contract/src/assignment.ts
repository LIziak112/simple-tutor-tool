import { z } from "zod";

/**
 * 作业契约（T2.2 起为权威定义）：教师端布置作业 CRUD 请求/响应、学生端作业列表
 * （仅本人被指派 + 完成状态）、作业模块错误码。
 * 依据：docs/技术架构与实施方案.md §5.2（assignments / assignment_students 表、
 * attempts 状态字段）、§5.8（完成矩阵状态 = 未开始/进行中/已交/已批）、
 * docs/开发任务清单.md T2.2、§0.3（响应壳/主键/时间约定）。
 *
 * 约定（与 student.ts / content-api.ts 一致）：
 * - 本文件只定义请求体/查询参数与 data 部分；响应壳统一由 index.ts 描述，
 *   此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 时间一律 UTC ISO 字符串（dueAt 前端用 datetime-local 输入，提交前转 UTC）；
 * - 学生端响应只含单元公开元信息（标题/topic/题数），绝不包含题目答案、
 *   详解、提示等教师侧内容（AGENTS.md 第 3 条；题目内容 T2.4 起单独下发）。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 字段策略 ----------

/** 作业标题最大长度（缺省用单元标题） */
export const ASSIGNMENT_TITLE_MAX = 100;

/**
 * 完成状态（§5.8 完成矩阵，T2.2 契约先定枚举）：
 * - not_started：未开始（无作答记录）；
 * - in_progress：进行中（有未交卷 attempt）；
 * - submitted：已交（已交卷未批改）；
 * - graded：已批（教师已批改）。
 * 计算收敛在服务端纯函数 computeAssignmentStatus（assignment-service），
 * T2.6 接入 attempts 后按「优先级 graded > submitted > in_progress > 无记录」补全。
 */
export const assignmentStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "submitted",
  "graded",
]);

/** 作业标题：trim 后 1–100 字符（缺省沿用单元标题） */
export const assignmentTitleSchema = z
  .string()
  .trim()
  .min(1, "作业标题不能为空")
  .max(ASSIGNMENT_TITLE_MAX, `作业标题最多 ${ASSIGNMENT_TITLE_MAX} 个字符`);

/**
 * 截止时间：UTC ISO 字符串（带 Z 后缀；datetime-local 本地值由前端转 UTC 后提交）。
 * 不接受无时区的本地格式（如 2026-09-30T18:00）与 +hh:mm 偏移写法，避免歧义。
 */
export const assignmentDueAtSchema = z.iso.datetime({ offset: false });

/** 学生 id（crypto.randomUUID；studentIds 由服务端逐个校验存在性） */
const studentIdSchema = z.uuid("studentId 必须是 UUID 格式");

// ---------- 教师端：布置作业 CRUD ----------

/**
 * POST /api/teacher/assignments 请求体。
 * - unitId 必须已存在（不存在 404 UNIT_NOT_FOUND）；
 * - title 缺省用单元标题；
 * - studentIds 至少一名（作业必须指派学生；重复 id 服务端去重）；
 * - dueAt 可选（UTC ISO）。
 */
export const assignmentCreateRequestSchema = z.object({
  unitId: z.string().min(1, "unitId 不能为空"),
  title: assignmentTitleSchema.optional(),
  studentIds: z.array(studentIdSchema).min(1, "作业必须至少指派一名学生"),
  dueAt: assignmentDueAtSchema.optional(),
});

/**
 * PATCH /api/teacher/assignments/:id 请求体（全部可选，缺省 = 不改）：
 * - title：改标题；
 * - dueAt：改截止时间；显式 null 表示取消截止（与「缺省不改」区分）；
 * - studentIds：全量替换指派名单（替换后名单外学生立即不可见）。
 */
export const assignmentUpdateRequestSchema = z.object({
  title: assignmentTitleSchema.optional(),
  dueAt: assignmentDueAtSchema.nullable().optional(),
  studentIds: z
    .array(studentIdSchema)
    .min(1, "作业必须至少指派一名学生")
    .optional(),
});

/** GET /api/teacher/assignments 查询参数：includeDeleted=true 时含已删除作业（默认不显示） */
export const assignmentListQuerySchema = z.object({
  includeDeleted: z.stringbool().optional(),
});

/** 指派学生摘要（教师列表用：姓名供卡片直接展示） */
export const assignmentStudentSchema = z.object({
  id: z.uuid(),
  displayName: z.string().min(1),
});

/**
 * 教师端作业摘要（列表行 / 创建与更新响应）。软删作业仅在 includeDeleted=true
 * 时出现（deleted=true + deletedAt）；作答记录不受删除影响（T2.6 起回归验证）。
 */
export const teacherAssignmentSchema = z.object({
  /** assignments.id（crypto.randomUUID） */
  id: z.uuid(),
  /** 目标练习单元 id（来自 DSL） */
  unitId: z.string().min(1),
  /** 单元标题（列表展示；创建时缺省 title 即取该值） */
  unitTitle: z.string().min(1),
  /** 作业标题（缺省 = 布置时的单元标题，不随后续单元改名联动） */
  title: z.string().min(1),
  /** 截止时间：UTC ISO；未设置为 null */
  dueAt: assignmentDueAtSchema.nullable(),
  /** 单元内有效题目数（软删题目不计；学生答题页题数与此一致） */
  questionCount: z.number().int().min(0),
  /** 指派学生名单（按创建/替换时的选择顺序） */
  students: z.array(assignmentStudentSchema),
  /** 是否已删除（deletedAt 非空；软删，作答保留） */
  deleted: z.boolean(),
  /** 删除时间：UTC ISO；未删除为 null */
  deletedAt: z.string().nullable(),
  /** 创建时间：UTC ISO 字符串 */
  createdAt: z.string().min(1),
});

/** GET /api/teacher/assignments 响应 data（默认按创建时间倒序） */
export const teacherAssignmentListDataSchema = z.object({
  assignments: z.array(teacherAssignmentSchema),
});

/** POST /api/teacher/assignments 响应 data（同列表行结构） */
export const assignmentCreateDataSchema = teacherAssignmentSchema;

/** PATCH /api/teacher/assignments/:id 响应 data（同列表行结构） */
export const assignmentUpdateDataSchema = teacherAssignmentSchema;

// ---------- 学生端：我的作业 ----------

/**
 * GET /api/student/assignments 响应 data 中的作业条目。
 * 仅含单元公开元信息（标题/topic/题数），不含题目内容与答案/详解/提示
 * （题目本体 T2.4 经 paper 接口按需下发）。
 */
export const studentAssignmentSchema = z.object({
  /** assignments.id */
  id: z.uuid(),
  /** 作业标题（教师布置时的标题或缺省单元标题） */
  title: z.string().min(1),
  /** 目标练习单元 id（来自 DSL；T2.4 领试卷用） */
  unitId: z.string().min(1),
  /** 单元标题 */
  unitTitle: z.string().min(1),
  /** 单元主题；未标注为 null */
  topic: z.string().nullable(),
  /** 单元内有效题目数（软删题目不计） */
  questionCount: z.number().int().min(0),
  /** 截止时间：UTC ISO；未设置为 null */
  dueAt: assignmentDueAtSchema.nullable(),
  /** 布置时间：UTC ISO 字符串 */
  createdAt: z.string().min(1),
  /** 完成状态（本任务内恒为 not_started，T2.6 接入 attempts 后补全） */
  status: assignmentStatusSchema,
});

/** GET /api/student/assignments 响应 data（按布置时间倒序） */
export const studentAssignmentListDataSchema = z.object({
  assignments: z.array(studentAssignmentSchema),
});

// ---------- 错误码 ----------

/**
 * 作业模块错误码（UPPER_SNAKE_CODE 固定子集）：
 * - ASSIGNMENT_NOT_FOUND：目标作业不存在（含已删除的按需接口）（404）；
 * - UNIT_NOT_FOUND：布置作业的 unitId 不存在（404）；
 * - STUDENT_NOT_FOUND：studentIds 中存在未知学生 id（404）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const assignmentErrorCodeSchema = z.enum([
  "ASSIGNMENT_NOT_FOUND",
  "UNIT_NOT_FOUND",
  "STUDENT_NOT_FOUND",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

// ---------- 具体化的成功壳 ----------

/** 携带教师作业列表的成功响应壳 */
export const teacherAssignmentListOkSchema = apiOkExtend(
  teacherAssignmentListDataSchema,
);
/** 携带创建结果的成功响应壳 */
export const assignmentCreateOkSchema = apiOkExtend(assignmentCreateDataSchema);
/** 携带更新结果的成功响应壳 */
export const assignmentUpdateOkSchema = apiOkExtend(assignmentUpdateDataSchema);
/** 携带学生作业列表的成功响应壳 */
export const studentAssignmentListOkSchema = apiOkExtend(
  studentAssignmentListDataSchema,
);

// ---------- 推断类型导出 ----------

export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;
export type AssignmentCreateRequest = z.infer<
  typeof assignmentCreateRequestSchema
>;
export type AssignmentUpdateRequest = z.infer<
  typeof assignmentUpdateRequestSchema
>;
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;
export type AssignmentStudent = z.infer<typeof assignmentStudentSchema>;
export type TeacherAssignment = z.infer<typeof teacherAssignmentSchema>;
export type TeacherAssignmentListData = z.infer<
  typeof teacherAssignmentListDataSchema
>;
export type StudentAssignment = z.infer<typeof studentAssignmentSchema>;
export type StudentAssignmentListData = z.infer<
  typeof studentAssignmentListDataSchema
>;
export type AssignmentErrorCode = z.infer<typeof assignmentErrorCodeSchema>;
