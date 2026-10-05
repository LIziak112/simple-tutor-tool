import { z } from "zod";
import { questionPublicSchema } from "./content.ts";

/**
 * 作业契约（T2.2 起为权威定义；T2A.7 大改——多单元内容 + 按课程布置 + 名单增删
 * + 内容锁定，D12–D16；T2A.8 追加答案公布时机 answerRelease，D11；2026-10 追加
 * 组合方式 unitGrouping——默认 merged 向后兼容，separate 每个单元一份作业，
 * 创建响应随之统一为 { assignments: [...] } 列表形态）：
 * 教师端布置作业 CRUD 请求/响应、布置前「已做过」检查（D15）、作业列表（按课程
 * 筛选）与详情、学生端作业列表与试卷、错误码。
 * 依据：docs/技术架构与实施方案.md §5.2（assignments / assignment_units /
 * assignment_students 表、attempts 状态字段）、docs/archive/Phase2A改进任务清单.md §2
 * D11（答案公布时机）、D12（多单元）、D13（名单增删与课程快照）、D14（内容锁定）、
 * D15（已做过提示）、D16（资源删除不影响作业）、§5 T2A.7/T2A.8。
 *
 * 约定（与 student.ts / content-api.ts 一致）：
 * - 本文件只定义请求体/查询参数与 data 部分；响应壳统一由 index.ts 描述，
 *   此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 时间一律 UTC ISO 字符串（dueAt 前端用 datetime-local 输入，提交前转 UTC）；
 * - 学生端列表响应只含单元公开元信息（标题/题数）；题目本体只经 paper 接口、
 *   以 QuestionPublic 形态下发（绝不包含答案/详解/提示内容，AGENTS.md 第 3 条）。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 字段策略 ----------

/** 作业标题最大长度（缺省用单元标题组合，见 defaultAssignmentTitle） */
export const ASSIGNMENT_TITLE_MAX = 100;

/**
 * 完成状态（§5.8 完成矩阵，T2.2 契约先定枚举）：
 * - not_started：未开始（无作答记录）；
 * - in_progress：进行中（有未交卷 attempt）；
 * - submitted：已交（已交卷未批改）；
 * - graded：已批（教师已批改）。
 * 计算收敛在服务端纯函数 computeAssignmentStatus（assignment-service）：
 * 优先级 graded > submitted > in_progress > not_started。
 */
export const assignmentStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "submitted",
  "graded",
]);

/** 作业标题：trim 后 1–100 字符（缺省规则见 assignmentCreateRequestSchema） */
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

/**
 * 答案公布时机（T2A.8，D11）：on_submit=交卷即公布（默认，现状语义）；
 * after_due=截止后公布——**必须设置截止时间**：create 选 after_due 而 dueAt 缺失、
 * 或 PATCH 把 dueAt 置 null / 去掉截止时当前为 after_due，均 400 VALIDATION_ERROR
 * （防死锁态：永不公布）。截止前学生结果视图只下发「已交卷」与本人答案，
 * 截止后（now ≥ dueAt）读时自动恢复完整结果（无定时任务）。
 * course 来源作答恒为交卷即公布（D11），不适用本字段。
 */
export const assignmentAnswerReleaseSchema = z.enum(["on_submit", "after_due"]);

/** 学生 id（crypto.randomUUID；studentIds 由服务端逐个校验存在性） */
const studentIdSchema = z.uuid("studentId 必须是 UUID 格式");

/**
 * 作业组合方式（2026-10 产品决策：默认不合并）：
 * - separate：每个单元一份作业——unitIds 顺序创建 N 份，每份只含一个单元，
 *   学生端分别看到 N 份，各自作答与交卷；
 * - merged：合并为一份作业（旧行为）——所有单元合成一份试卷，一次作答一次交卷。
 * 缺省/不传 = merged：向后兼容，契约发布前既有调用行为不变（服务端 ?? "merged"）。
 */
export const assignmentUnitGroupingSchema = z.enum(["separate", "merged"]);

/**
 * 单元 id（来自 DSL，如 "unit-一元一次方程"——非 UUID）；不存在由服务端 404。
 * 同一请求内重复由服务端判 400 DUPLICATE_UNIT（D12：同一作业中单元不可重复）。
 */
const unitIdSchema = z.string().min(1, "unitId 不能为空");

/**
 * 缺省标题规则（D12/T2A.7）：1 个单元 = 该单元标题；≥2 个单元 =
 * 「首个单元标题 等 n 个单元」。快照语义：此后单元改名不联动已布置作业的标题。
 */
export function defaultAssignmentTitle(unitTitles: readonly string[]): string {
  const first = unitTitles[0] ?? "";
  if (unitTitles.length <= 1) return first;
  return `${first} 等 ${unitTitles.length} 个单元`;
}

// ---------- 教师端：布置作业 CRUD（T2A.7 多单元 + 课程） ----------

/**
 * POST /api/teacher/assignments 请求体（D12/D13）。
 * - unitIds：布置顺序即作业内单元顺序（assignment_units.order=0..n-1），
 *   至少 1 个；单元不存在 404 UNIT_NOT_FOUND；重复 400 DUPLICATE_UNIT；
 * - courseId：可选所属课程；不存在 404 COURSE_NOT_FOUND；选了课程也不自动
 *   带名单——名单由 studentIds 显式给出（前端向导负责「带出课程成员」交互）；
 * - title 缺省规则见 defaultAssignmentTitle；
 * - studentIds 至少一名（服务端去重并逐个校验存在）；
 * - dueAt 可选（UTC ISO）；answerRelease 可选（T2A.8，默认 on_submit；
 *   after_due 时 dueAt 必填，否则服务端 400 VALIDATION_ERROR）；
 * - unitGrouping 可选（默认 merged）：separate = 每个单元一份作业（一个事务按
 *   unitIds 顺序创建 N 份，courseId/studentIds/dueAt/answerRelease 共用），
 *   merged = 合并一份（现状行为，完全不因本字段变化）。
 */
export const assignmentCreateRequestSchema = z.object({
  title: assignmentTitleSchema.optional(),
  courseId: z.uuid("courseId 必须是 UUID 格式").nullable().optional(),
  unitIds: z.array(unitIdSchema).min(1, "作业必须至少包含一个练习单元"),
  studentIds: z.array(studentIdSchema).min(1, "作业必须至少指派一名学生"),
  dueAt: assignmentDueAtSchema.optional(),
  answerRelease: assignmentAnswerReleaseSchema.optional(),
  unitGrouping: assignmentUnitGroupingSchema.optional(),
});

/**
 * PATCH /api/teacher/assignments/:id 请求体（全部可选，缺省 = 不改；D13/D14）：
 * - title：改标题；dueAt：改截止时间，显式 null 表示取消截止；
 * - unitIds：整组替换单元列表（同 create 校验）。**只要任一学生创建过该作业的
 *   attempt 即锁定，返回 409 ASSIGNMENT_CONTENT_LOCKED**（D14）；标题、截止、
 *   名单不受锁定影响；
 * - addStudentIds：增量加入名单（校验存在；已在册则刷新 addedAt）；
 * - removeStudentIds：增量移出名单（校验存在且在册）。移出的学生中若有人已
 *   开始作答（存在该作业的 attempt），必须携带 confirmStarted: true，否则
 *   409 CONFIRM_REQUIRED 且错误壳附带 _students: [{studentId, displayName}]；
 * - addStudentIds 与 removeStudentIds 的交集 → 400 VALIDATION_ERROR；
 * - answerRelease：改公布时机（T2A.8）。与 dueAt 的组合校验：改后状态为
 *   after_due 而截止缺失（当前无截止直接改 after_due，或 after_due 下把
 *   dueAt 置 null / 取消截止）→ 400 VALIDATION_ERROR（防死锁态）；
 * - courseId 创建后不可改（本 schema 无该字段）——如需调整所属课程，
 *   删除后重新布置（D13 有意不支持改挂）。
 */
export const assignmentUpdateRequestSchema = z.object({
  title: assignmentTitleSchema.optional(),
  dueAt: assignmentDueAtSchema.nullable().optional(),
  answerRelease: assignmentAnswerReleaseSchema.optional(),
  unitIds: z.array(unitIdSchema).min(1, "unitIds 不能为空数组").optional(),
  addStudentIds: z.array(studentIdSchema).optional(),
  removeStudentIds: z.array(studentIdSchema).optional(),
  confirmStarted: z.boolean().optional(),
});

/**
 * POST /api/teacher/assignments/check 请求体（D15 布置前「已做过」检查）：
 * 名单学生 × 所选单元 → 学生在课程练习中**已交卷**过的记录提示。仅提示不阻止。
 */
export const assignmentCheckRequestSchema = z.object({
  unitIds: z.array(unitIdSchema).min(1, "至少选择一个练习单元"),
  studentIds: z.array(studentIdSchema).min(1, "至少选择一名学生"),
});

/** D15 提示行：一名学生在一个课程中对一个单元的已交卷次数 */
export const assignmentCheckHintSchema = z.object({
  /** 学生 id */
  studentId: z.uuid(),
  /** 学生姓名 */
  studentName: z.string().min(1),
  /** 课程练习所属课程（course 来源 attempts.courseId；异常空值为 null） */
  courseId: z.uuid().nullable(),
  /** 课程名（courseId 为 null 时为 null） */
  courseName: z.string().min(1).nullable(),
  /** 单元 id */
  unitId: z.string().min(1),
  /** 单元标题（当前值） */
  unitTitle: z.string().min(1),
  /** 已交卷次数（sourceType='course' 且 status∈{submitted,graded} 的 attempt 数） */
  submittedCount: z.number().int().min(1),
});

/** POST /api/teacher/assignments/check 响应 data（未做过/仅草稿的学生×单元无行） */
export const assignmentCheckDataSchema = z.object({
  hints: z.array(assignmentCheckHintSchema),
});

/**
 * GET /api/teacher/assignments 查询参数（T2A.7 扩展 courseId 筛选）：
 * - includeDeleted=true 时含已删除作业（默认不显示）；
 * - courseId：UUID = 只看该课程的作业；"none" = 只看无课程作业；缺省 = 全部。
 *   非法值（既非 UUID 也非 "none"）400 VALIDATION_ERROR。
 */
export const assignmentListQuerySchema = z.object({
  includeDeleted: z.stringbool().optional(),
  courseId: z
    .union([z.uuid("courseId 必须是 UUID 或 none"), z.literal("none")])
    .optional(),
});

/** 教师端作业卡片的单元投影（D12/D16：含软删标记与 live 题数） */
export const teacherAssignmentUnitSchema = z.object({
  /** 练习单元 id（来自 DSL） */
  unitId: z.string().min(1),
  /** 单元标题（当前值；软删后仍返回） */
  title: z.string().min(1),
  /** 单元内有效题目数（软删题目不计；D16：软删单元照常可作答，题数照常统计） */
  questionCount: z.number().int().min(0),
  /** 单元是否已软删（D16：「含已删除单元」提示的数据源之一） */
  deleted: z.boolean(),
});

/** 名单四态统计（在册成员按人计，优先级 graded > submitted > in_progress > not_started） */
export const assignmentRosterStatsSchema = z.object({
  notStarted: z.number().int().min(0),
  inProgress: z.number().int().min(0),
  submitted: z.number().int().min(0),
  graded: z.number().int().min(0),
});

/**
 * 教师端作业摘要（列表行 / 创建与更新响应；T2A.7 重定义）。
 * - units：按布置顺序（assignment_units.order）；totalQuestionCount = 各单元
 *   live 题数之和；containsDeletedUnit = 任一单元已软删（D16）；
 * - locked：已有任一学生创建过该作业的 attempt（D14：内容锁定）；
 * - rosterStats / studentCount：在册名单（removedAt IS NULL）的统计。
 */
export const teacherAssignmentSchema = z.object({
  /** assignments.id（crypto.randomUUID） */
  id: z.uuid(),
  /** 所属课程（D13）；未挂课程为 null */
  courseId: z.uuid().nullable(),
  /** 所属课程名（当前值）；未挂课程为 null */
  courseName: z.string().min(1).nullable(),
  /** 作业标题（缺省规则见 defaultAssignmentTitle，快照语义不随单元改名联动） */
  title: z.string().min(1),
  /** 截止时间：UTC ISO；未设置为 null */
  dueAt: assignmentDueAtSchema.nullable(),
  /** 答案公布时机（T2A.8，D11）：交卷即公布（默认）/ 截止后公布（需截止时间） */
  answerRelease: assignmentAnswerReleaseSchema,
  /** 单元列表（按布置顺序；含软删单元） */
  units: z.array(teacherAssignmentUnitSchema),
  /** 全部单元 live 题数之和（学生答题页题数与此一致） */
  totalQuestionCount: z.number().int().min(0),
  /** 是否含已软删单元（D16 提示） */
  containsDeletedUnit: z.boolean(),
  /** 内容是否锁定（任一学生创建过 attempt，D14） */
  locked: z.boolean(),
  /** 在册学生数（removedAt IS NULL） */
  studentCount: z.number().int().min(0),
  /** 在册名单四态统计 */
  rosterStats: assignmentRosterStatsSchema,
  /** 是否已删除（deletedAt 非空；软删，作答保留） */
  deleted: z.boolean(),
  /** 删除时间：UTC ISO；未删除为 null（min(1) 拦空串，与 createdAt 口径一致） */
  deletedAt: z.string().min(1).nullable(),
  /** 创建时间：UTC ISO 字符串 */
  createdAt: z.string().min(1),
});

/** GET /api/teacher/assignments 响应 data（默认按创建时间倒序） */
export const teacherAssignmentListDataSchema = z.object({
  assignments: z.array(teacherAssignmentSchema),
});

/**
 * POST /api/teacher/assignments 响应 data（2026-10 组合方式起统一为列表形态）：
 * 本批创建的全部作业按创建顺序排列——merged（缺省）= 恰一个元素（同列表行结构，
 * 行为不变）；separate = unitIds 顺序的 N 个元素。前端拿全批作业，不需要按模式
 * 分叉解析；空数组的响应不可能出现（创建至少产出一份），min(1) 固化该口径。
 */
export const assignmentCreateDataSchema = z.object({
  assignments: z.array(teacherAssignmentSchema).min(1),
});

/** PATCH /api/teacher/assignments/:id 响应 data（同列表行结构） */
export const assignmentUpdateDataSchema = teacherAssignmentSchema;

/** 详情名单行（D13：每人状态徽章数据；在册成员，按加入时间后姓名排序） */
export const assignmentRosterEntrySchema = z.object({
  studentId: z.uuid(),
  displayName: z.string().min(1),
  /** 该学生在本作业下的完成状态（graded > submitted > in_progress > not_started） */
  status: assignmentStatusSchema,
  /**
   * 该生在本作业下的 attempt id（一人一份：draft 幂等、交卷后不再新建）。
   * status 取同优先级（graded > submitted > draft）的代表行；未开始为 null。
   * T3.1（D8）：名单状态徽章点击 → attempt 详情 /t/data/attempts/:id 的定位 id。
   */
  attemptId: z.uuid().nullable(),
  /** 加入名单时间：UTC ISO（assignment_students.addedAt） */
  addedAt: z.string().min(1),
});

/** 「课程新成员」（D13：当前课程成员 − 在册名单；无课程时空数组） */
export const assignmentCourseMemberSchema = z.object({
  studentId: z.uuid(),
  displayName: z.string().min(1),
});

/**
 * GET /api/teacher/assignments/:id 响应 data（T2A.7 详情）：列表行全部字段 +
 * 名单明细（roster）、已开始人数（startedCount，D14 锁定原因展示）与
 * 课程新成员列表（courseNewMembers，「补充课程新成员」按钮数据源）。
 */
export const assignmentDetailDataSchema = teacherAssignmentSchema.extend({
  roster: z.array(assignmentRosterEntrySchema),
  /** 已创建过该作业 attempt 的在册学生数（D14 锁定原因「已有 n 人开始作答」） */
  startedCount: z.number().int().min(0),
  courseNewMembers: z.array(assignmentCourseMemberSchema),
});

// ---------- 学生端：我的作业 ----------

/** 学生端作业卡片的单元公开元信息（无题数——题数聚合在作业级 questionCount） */
export const studentAssignmentUnitSchema = z.object({
  /** 练习单元 id（来自 DSL） */
  id: z.string().min(1),
  /** 单元标题（当前值） */
  title: z.string().min(1),
});

/**
 * GET /api/student/assignments 响应 data 中的作业条目（T2A.7 多单元化）。
 * 仅含单元公开元信息（标题），不含题目内容与答案/详解/提示（题目本体经
 * paper 接口按需下发）；卡片展示「n 个单元 · 共 m 题」。
 */
export const studentAssignmentSchema = z.object({
  /** assignments.id */
  id: z.uuid(),
  /** 作业标题（教师布置时的标题或缺省组合，快照语义） */
  title: z.string().min(1),
  /** 单元列表（按布置顺序；标题取当前值） */
  units: z.array(studentAssignmentUnitSchema),
  /** 单元数（= units.length，卡片快捷展示） */
  unitCount: z.number().int().min(0),
  /** 全部单元有效题目数之和（软删题目不计） */
  questionCount: z.number().int().min(0),
  /** 截止时间：UTC ISO；未设置为 null */
  dueAt: assignmentDueAtSchema.nullable(),
  /** 布置时间：UTC ISO 字符串 */
  createdAt: z.string().min(1),
  /** 完成状态（服务端由该学生的 attempts 推导：graded > submitted > in_progress > not_started） */
  status: assignmentStatusSchema,
});

/** GET /api/student/assignments 响应 data（按布置时间倒序） */
export const studentAssignmentListDataSchema = z.object({
  assignments: z.array(studentAssignmentSchema),
});

// ---------- 学生端：试卷（T2.4；T2A.7 分组化） ----------

/** 试卷单元分组（T2A.7：题号全卷连续由 units 顺序 + 各单元题序共同保证） */
export const studentPaperUnitSchema = z.object({
  /** 练习单元 id（来自 DSL） */
  id: z.string().min(1),
  /** 单元标题（当前值；答题页分节标题。软删单元行保留在回收站，标题仍可读） */
  title: z.string().min(1),
  /** 该单元的公开题目（QuestionPublic[]，按单元内题序） */
  questions: z.array(questionPublicSchema),
});

/**
 * GET /api/student/assignments/:id/paper 响应 data（T2A.7 改分组结构）：
 * units 按布置顺序（assignment_units.order）；**live 题数为 0 的单元不出现**
 * （题目全被软删/清空；D16：单元软删不影响出卷，引用单元的题目照常下发）；
 * 全部为 0 时 units 为空数组（前端按空卷兜底提示）。
 *
 * 安全口径（AGENTS.md 第 3 条 / 架构文档 §5.3）：
 * - questions 元素必须是 questionPublicSchema 解析（strip 语义）后的输出：
 *   服务端从 questions 行构造时携带的 answersJson / solutionMd / hintsJson /
 *   sourceMd 等教师侧列一律被剥离，将来加列也不会经由本响应泄露；
 * - 顺序 = 布置顺序 × 单元题序（questions.order 升序），软删题目不出现；
 * - stemMd 为脱敏后的题干（填空/判断标记 [[答案]] 已替换为空标记 [[]]）；
 * - options 仅 choice/multi 携带，且是纯文本数组（无 correct 正确项标记）。
 */
export const studentPaperDataSchema = z.object({
  units: z.array(studentPaperUnitSchema),
});

/** 携带学生试卷的成功响应壳 */
export const studentPaperOkSchema = apiOkExtend(studentPaperDataSchema);

// ---------- 错误码 ----------

/**
 * 作业模块错误码（UPPER_SNAKE_CODE 固定子集；T2A.7 追加 4 个）：
 * - ASSIGNMENT_NOT_FOUND：目标作业不存在（含已删除的按需接口）（404）；
 * - UNIT_NOT_FOUND：unitIds 中存在未知单元（404）；
 * - COURSE_NOT_FOUND：courseId 不存在（404，T2A.7）；
 * - STUDENT_NOT_FOUND：studentIds 中存在未知学生 id（404）；
 * - DUPLICATE_UNIT：unitIds 重复（同一作业单元不可重复，400，D12/T2A.7）；
 * - ASSIGNMENT_CONTENT_LOCKED：已锁定（有 attempt）后修改 unitIds
 *   （409，D14/T2A.7）；
 * - CONFIRM_REQUIRED：移出已开始作答的学生未带 confirmStarted（409，D13/T2A.7；
 *   错误壳附带 _students: [{studentId, displayName}]）；
 * - FORBIDDEN：学生请求未被指派给自己的作业（403）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义（401 / 400）。
 */
export const assignmentErrorCodeSchema = z.enum([
  "ASSIGNMENT_NOT_FOUND",
  "UNIT_NOT_FOUND",
  "COURSE_NOT_FOUND",
  "STUDENT_NOT_FOUND",
  "DUPLICATE_UNIT",
  "ASSIGNMENT_CONTENT_LOCKED",
  "CONFIRM_REQUIRED",
  "FORBIDDEN",
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
/** 携带作业详情的成功响应壳（T2A.7） */
export const assignmentDetailOkSchema = apiOkExtend(assignmentDetailDataSchema);
/** 携带 D15 已做过检查结果的成功响应壳（T2A.7） */
export const assignmentCheckOkSchema = apiOkExtend(assignmentCheckDataSchema);
/** 携带学生作业列表的成功响应壳 */
export const studentAssignmentListOkSchema = apiOkExtend(
  studentAssignmentListDataSchema,
);

// ---------- 推断类型导出 ----------

export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;
export type AssignmentAnswerRelease = z.infer<
  typeof assignmentAnswerReleaseSchema
>;
export type AssignmentCreateRequest = z.infer<
  typeof assignmentCreateRequestSchema
>;
export type AssignmentUnitGrouping = z.infer<
  typeof assignmentUnitGroupingSchema
>;
export type AssignmentUpdateRequest = z.infer<
  typeof assignmentUpdateRequestSchema
>;
export type AssignmentCheckRequest = z.infer<
  typeof assignmentCheckRequestSchema
>;
export type AssignmentCheckHint = z.infer<typeof assignmentCheckHintSchema>;
export type AssignmentCheckData = z.infer<typeof assignmentCheckDataSchema>;
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;
export type TeacherAssignmentUnit = z.infer<typeof teacherAssignmentUnitSchema>;
export type AssignmentRosterStats = z.infer<typeof assignmentRosterStatsSchema>;
export type TeacherAssignment = z.infer<typeof teacherAssignmentSchema>;
export type AssignmentCreateData = z.infer<typeof assignmentCreateDataSchema>;
export type TeacherAssignmentListData = z.infer<
  typeof teacherAssignmentListDataSchema
>;
export type AssignmentRosterEntry = z.infer<typeof assignmentRosterEntrySchema>;
export type AssignmentCourseMember = z.infer<
  typeof assignmentCourseMemberSchema
>;
export type AssignmentDetailData = z.infer<typeof assignmentDetailDataSchema>;
export type StudentAssignmentUnit = z.infer<typeof studentAssignmentUnitSchema>;
export type StudentAssignment = z.infer<typeof studentAssignmentSchema>;
export type StudentAssignmentListData = z.infer<
  typeof studentAssignmentListDataSchema
>;
export type StudentPaperUnit = z.infer<typeof studentPaperUnitSchema>;
export type StudentPaperData = z.infer<typeof studentPaperDataSchema>;
export type AssignmentErrorCode = z.infer<typeof assignmentErrorCodeSchema>;
