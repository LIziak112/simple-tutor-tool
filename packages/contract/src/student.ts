import { z } from "zod";

/**
 * 学生账号契约（T2.1 起为权威定义）：学生 CRUD 请求/响应、两种登录（专属链接 /
 * 登录名+密码）、学生自助信息与改密码、学生模块错误码。
 * 依据：docs/技术架构与实施方案.md §5.2（students 表）、§5.7（身份与安全：
 * 两种登录并存、90 天学生会话、5 次失败锁 10 分钟）、docs/开发任务清单.md T2.1、§0.3。
 *
 * 约定（与 auth.ts / content-api.ts 一致）：
 * - 本文件只定义请求体/查询参数与 data 部分；响应壳统一由 index.ts 描述，
 *   此处仅用局部 helper 具体化成功壳（避免循环依赖）；
 * - 教师端接口（/api/teacher/students*）无泄露约束，响应携带 linkToken 供教师
 *   复制专属链接；学生端（/api/student/*）与公开接口绝不返回 linkToken、
 *   passwordHash 等内部凭证（studentMeDataSchema 已排除）。
 */

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

// ---------- 字段策略 ----------

/** 学生密码策略：至少 6 个字符（面向中小学生，比教师的 8 位放宽），最长 128（防超大输入撑爆 scrypt） */
export const STUDENT_PASSWORD_MIN = 6;
export const STUDENT_PASSWORD_MAX = 128;

/** 姓名 / 登录名最大长度（登录名默认等于姓名，允许中文，§5.7） */
export const STUDENT_NAME_MAX = 32;

/** 备注最大长度 */
export const STUDENT_NOTE_MAX = 200;

/** 学生显示姓名：trim 后 1–32 字符 */
export const studentDisplayNameSchema = z
  .string()
  .trim()
  .min(1, "姓名不能为空")
  .max(STUDENT_NAME_MAX, `姓名最多 ${STUDENT_NAME_MAX} 个字符`);

/**
 * 登录名：trim 后 1–32 字符，允许中文（默认等于姓名，重名时改成「张三2」之类，§5.7）；
 * 全局唯一（大小写敏感精确匹配，见 student-service）。
 */
export const studentLoginNameSchema = z
  .string()
  .trim()
  .min(1, "登录名不能为空")
  .max(STUDENT_NAME_MAX, `登录名最多 ${STUDENT_NAME_MAX} 个字符`);

/** 学生密码（创建提供初始密码 / 自助修改新密码时校验；登录时只要求非空） */
export const studentPasswordSchema = z
  .string()
  .min(STUDENT_PASSWORD_MIN, `密码至少需要 ${STUDENT_PASSWORD_MIN} 个字符`)
  .max(STUDENT_PASSWORD_MAX, `密码最多 ${STUDENT_PASSWORD_MAX} 个字符`);

/** 备注：trim 后可为空（空按无备注存 null）；最多 200 字符 */
export const studentNoteSchema = z
  .string()
  .trim()
  .max(STUDENT_NOTE_MAX, `备注最多 ${STUDENT_NOTE_MAX} 个字符`);

// ---------- 教师端：学生 CRUD ----------

/**
 * POST /api/teacher/students 请求体。
 * password 可选：未提供则服务端生成随机初始密码（响应 initialPassword 返回一次明文）；
 * note 可选。创建后两种登录方式默认全部开启（linkToken 创建时生成，§5.7）。
 */
export const studentCreateRequestSchema = z.object({
  displayName: studentDisplayNameSchema,
  loginName: studentLoginNameSchema,
  password: studentPasswordSchema.optional(),
  note: studentNoteSchema.optional(),
});

/**
 * PATCH /api/teacher/students/:id 请求体（全部可选，缺省 = 不改）：
 * - displayName / loginName：改名与登录名（loginName 仍要求全局唯一）；
 * - linkEnabled / passwordEnabled：开关两种登录方式（§5.7「可对单个学生分别开关」）；
 * - archived：true 归档（archivedAt 置当前时间）、false 取消归档（置 null）；
 * - note：备注（空串清空）。
 */
export const studentUpdateRequestSchema = z.object({
  displayName: studentDisplayNameSchema.optional(),
  loginName: studentLoginNameSchema.optional(),
  linkEnabled: z.boolean().optional(),
  passwordEnabled: z.boolean().optional(),
  archived: z.boolean().optional(),
  note: studentNoteSchema.optional(),
});

/** GET /api/teacher/students 查询参数：includeArchived=true 时列表包含已归档学生（默认只列未归档） */
export const studentListQuerySchema = z.object({
  includeArchived: z.stringbool().optional(),
});

/**
 * 教师端学生摘要（列表行 / PATCH 响应）。linkToken 仅教师端可见（复制专属链接用），
 * 学生端接口绝不返回该字段。
 */
export const studentSummarySchema = z.object({
  /** students.id（crypto.randomUUID） */
  id: z.uuid(),
  displayName: z.string().min(1),
  loginName: z.string().min(1),
  /** 专属链接登录是否开启 */
  linkEnabled: z.boolean(),
  /** 密码登录是否开启 */
  passwordEnabled: z.boolean(),
  /** 是否已设置过密码（重置密码 / 自助改密的判断依据；与 passwordEnabled 独立） */
  hasPassword: z.boolean(),
  /** 当前专属链接令牌（教师复制 `${origin}/s/${linkToken}` 用；重置后立即更换） */
  linkToken: z.string().min(1),
  /** 备注；未填为 null */
  note: z.string().nullable(),
  /** 是否已归档（archivedAt 非空） */
  archived: z.boolean(),
  /** 创建时间：UTC ISO 字符串 */
  createdAt: z.string().min(1),
});

/** GET /api/teacher/students 响应 data */
export const studentListDataSchema = z.object({
  students: z.array(studentSummarySchema),
});

/**
 * POST /api/teacher/students 响应 data。
 * initialPassword：创建时未提供密码则服务端生成，此处返回一次明文（仅此一次，
 * 之后任何接口不再返回）；教师提供了密码则为 null（教师自己已知）。
 */
export const studentCreateDataSchema = z.object({
  student: studentSummarySchema,
  /** 一次性初始密码明文；教师自备密码时为 null */
  initialPassword: z.string().min(1).nullable(),
});

/** POST /api/teacher/students/:id/reset-password 响应 data：新密码的一次性明文 */
export const studentResetPasswordDataSchema = z.object({
  password: z.string().min(1),
});

/** POST /api/teacher/students/:id/reset-link 响应 data：新 linkToken（旧链接立即失效） */
export const studentResetLinkDataSchema = z.object({
  linkToken: z.string().min(1),
});

// ---------- 公开接口：两种登录 ----------

/** POST /api/public/student/login 请求体（登录页输入，密码只要求非空） */
export const studentLoginRequestSchema = z.object({
  loginName: z.string().trim().min(1, "请输入登录名").max(STUDENT_NAME_MAX),
  password: z.string().min(1, "请输入密码").max(STUDENT_PASSWORD_MAX),
});

/**
 * 登录成功后返回的学生基本信息（密码登录 / 链接登录 / GET /api/student/me 共用）。
 * 不含 linkToken、passwordHash 等内部凭证。
 */
export const studentMeDataSchema = z.object({
  id: z.uuid(),
  displayName: z.string().min(1),
  loginName: z.string().min(1),
  linkEnabled: z.boolean(),
  passwordEnabled: z.boolean(),
});

// ---------- 学生端接口 ----------

/** POST /api/student/password 请求体：自助修改密码（需验证原密码） */
export const studentPasswordChangeRequestSchema = z.object({
  oldPassword: z.string().min(1, "请输入原密码").max(STUDENT_PASSWORD_MAX),
  newPassword: studentPasswordSchema,
});

// ---------- 错误码 ----------

/**
 * 学生模块错误码（UPPER_SNAKE_CODE 固定子集；与 auth 模块共用的不重复定义语义）：
 * - STUDENT_NOT_FOUND：目标学生不存在（404）；
 * - LOGIN_NAME_TAKEN：登录名已被其他学生占用（409）；
 * - LINK_INVALID：专属链接不存在 / 已被重置 / 已关闭 / 学生已归档（401）；
 * - INVALID_CREDENTIALS：密码登录失败（登录名不存在 / 密码错 / 方式关闭 / 已归档，统一口径防枚举）；
 * - LOCKED：连续失败达到阈值被临时锁定（§5.7）；
 * - UNAUTHORIZED / VALIDATION_ERROR：与 auth 模块同义。
 */
export const studentErrorCodeSchema = z.enum([
  "STUDENT_NOT_FOUND",
  "LOGIN_NAME_TAKEN",
  "LINK_INVALID",
  "INVALID_CREDENTIALS",
  "LOCKED",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
]);

// ---------- 具体化的成功壳 ----------

/** 携带学生列表的成功响应壳 */
export const studentListOkSchema = apiOkExtend(studentListDataSchema);
/** 携带创建结果（含一次性初始密码）的成功响应壳 */
export const studentCreateOkSchema = apiOkExtend(studentCreateDataSchema);
/** 携带学生摘要的成功响应壳（PATCH） */
export const studentUpdateOkSchema = apiOkExtend(studentSummarySchema);
/** 携带重置密码结果的成功响应壳 */
export const studentResetPasswordOkSchema = apiOkExtend(
  studentResetPasswordDataSchema,
);
/** 携带重置链接结果的成功响应壳 */
export const studentResetLinkOkSchema = apiOkExtend(studentResetLinkDataSchema);
/** 携带学生基本信息（登录成功 / me）的成功响应壳 */
export const studentMeOkSchema = apiOkExtend(studentMeDataSchema);

// ---------- 推断类型导出 ----------

export type StudentCreateRequest = z.infer<typeof studentCreateRequestSchema>;
export type StudentUpdateRequest = z.infer<typeof studentUpdateRequestSchema>;
export type StudentListQuery = z.infer<typeof studentListQuerySchema>;
export type StudentSummary = z.infer<typeof studentSummarySchema>;
export type StudentListData = z.infer<typeof studentListDataSchema>;
export type StudentCreateData = z.infer<typeof studentCreateDataSchema>;
export type StudentResetPasswordData = z.infer<
  typeof studentResetPasswordDataSchema
>;
export type StudentResetLinkData = z.infer<typeof studentResetLinkDataSchema>;
export type StudentLoginRequest = z.infer<typeof studentLoginRequestSchema>;
export type StudentMeData = z.infer<typeof studentMeDataSchema>;
export type StudentPasswordChangeRequest = z.infer<
  typeof studentPasswordChangeRequestSchema
>;
export type StudentErrorCode = z.infer<typeof studentErrorCodeSchema>;
